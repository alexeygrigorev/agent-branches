"""Offline end-to-end test suite for Agent Branches L2 Client."""

import datetime
import json
import os
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

from agent_branches.client import (
    AgentBranchesAPIError,
    AgentBranchesClient,
    AgentBranchesConnectionError,
    StaleVectorError,
    TokenExpiredError,
    TokenRevokedError,
)
from agent_branches.git_utils import (
    get_changed_files,
    get_current_branch,
    get_current_head_sha,
    get_remote_url,
    run_git_cmd,
)
from tests.mock_l1_server import (
    MockCoordinatorState,
    MockL1Handler,
    MockL1Server,
    start_mock_l1_server,
)


class _StatusAuthHandler(MockL1Handler):
    """Mock L1 handler that bearer-protects GET /status (mirrors current L1)."""

    expected_status_token = "run-status-token"

    def do_GET(self):
        if urllib.parse.urlparse(self.path).path == "/status":
            err = self.state.check_bearer_token(
                self.headers.get("Authorization", ""),
                self.expected_status_token,
                None,
                "runner",
            )
            if err:
                self._send_json(err[0], err[1])
                return
        super().do_GET()


class _StatusAuthServer(MockL1Server):
    """MockL1Server bound to the /status-authenticating handler."""

    def __init__(self, server_address, state=None):
        socketserver.TCPServer.__init__(self, server_address, _StatusAuthHandler)
        self.state = state or MockCoordinatorState()


class _AlwaysStaleClient(AgentBranchesClient):
    """Stub client whose send_checks always returns 409; records resync-loop behavior."""

    def __init__(self, fresh_heads=None):
        super().__init__(server_url="http://127.0.0.1:1", timeout=0.5)
        self.fresh_heads = dict(fresh_heads or {})
        self.send_calls = 0
        self.refresh_calls = 0

    def send_checks(self, payload, runner_token=None, return_error_dict=False):
        self.send_calls += 1
        raise StaleVectorError(409, "Head vector is stale: unit-stub", None)

    def refresh_head_vector(self, runner_token=None):
        self.refresh_calls += 1
        return dict(self.fresh_heads)


class _CountingSendClient(AgentBranchesClient):
    """Real client that counts how many /checks submissions are attempted."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.send_calls = 0

    def send_checks(self, payload, runner_token=None, return_error_dict=False):
        self.send_calls += 1
        return super().send_checks(
            payload, runner_token=runner_token, return_error_dict=return_error_dict
        )


class TestAgentBranchesClient(unittest.TestCase):
    """End-to-end tests verifying client, CLI, mock coordinator, and git utilities."""

    @classmethod
    def setUpClass(cls):
        cls.server, cls.thread, cls.server_url, cls.state = start_mock_l1_server(
            host="127.0.0.1", port=0
        )
        cls.repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        cls.cli_path = os.path.join(cls.repo_root, "agent-branches")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def run_cli(self, args, env_vars=None, check=True, input_data=None):
        """Helper to run agent-branches CLI via subprocess."""
        cmd = [sys.executable, self.cli_path] + args
        env = dict(os.environ)
        env["PYTHONPATH"] = self.repo_root
        if env_vars:
            env.update(env_vars)
        res = subprocess.run(
            cmd,
            input=input_data,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        if check and res.returncode != 0:
            raise AssertionError(
                f"CLI command failed with code {res.returncode}:\n"
                f"STDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"
            )
        return res


    def test_01_mock_l1_server_routes_directly(self):
        """Test mock L1 server routes directly via urllib."""
        # 1. POST /tasks returns distinct taskId and agentId
        task_payload = {
            "repo": "https://github.com/org/repo.git",
            "base_sha": "a1b2c3d4e5f60000000000000000000000000000",
            "branch": "feat/direct-test",
            "intent": "Testing direct route",
            "agent": "worker",
        }
        req = urllib.request.Request(
            f"{self.server_url}/tasks",
            data=json.dumps(task_payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 201)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertIn("taskId", data)
            self.assertIn("agentId", data)
            self.assertNotEqual(data["taskId"], data["agentId"])
            self.assertIn("forkUrl", data)
            self.assertEqual(data["branch"], "feat/direct-test")
            task_id = data["taskId"]
            agent_id = data["agentId"]

        # 2. POST /events/push requires agentId
        push_payload = {
            "agentId": agent_id,
            "head_sha": "b2c3d4e5f6a10000000000000000000000000000",
            "base_sha": "a1b2c3d4e5f60000000000000000000000000000",
            "files_changed": ["src/middleware.ts"],
            "intent": "Updated middleware",
            "test_provenance": "vitest: 10 passed",
        }
        req = urllib.request.Request(
            f"{self.server_url}/events/push",
            data=json.dumps(push_payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(data["accepted"])
            self.assertEqual(data["agentId"], agent_id)
            self.assertFalse(data["deduped"])

        # 2b. POST /events/push with taskId mistakenly sent as agentId is rejected
        bad_push_payload = {
            "agentId": task_id,
            "head_sha": "c3d4e5f6a1b20000000000000000000000000000",
        }
        req_bad = urllib.request.Request(
            f"{self.server_url}/events/push",
            data=json.dumps(bad_push_payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req_bad)
        self.assertEqual(ctx.exception.code, 404)

        # 3. GET /status
        req = urllib.request.Request(f"{self.server_url}/status")
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertIn("canonical", data)
            self.assertIn("tasks", data)
            self.assertIn("warnings", data)

        # 4. GET /tasks/<id> returns both taskId and agentId
        req = urllib.request.Request(f"{self.server_url}/tasks/{task_id}")
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(data["task_id"], task_id)
            self.assertEqual(data["agentId"], agent_id)
            self.assertEqual(data["intent"], "Updated middleware")

        # 5. POST /warnings/<id>/ack
        with self.state.lock:
            warn_id = "warn-direct-001"
            self.state.warnings[warn_id] = {
                "warning_id": warn_id,
                "pair": [task_id, "other-task"],
                "heads": {task_id: "sha1", "other-task": "sha2"},
                "status": "active",
                "kind": "textual",
            }

        ack_payload = {"task_id": task_id, "action": "rebased_locally"}
        req = urllib.request.Request(
            f"{self.server_url}/warnings/{warn_id}/ack",
            data=json.dumps(ack_payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(data["acknowledged"])
            self.assertEqual(data["action"], "rebased_locally")

    def test_02_distinct_agent_id_vs_task_id_flow(self):
        """Test client automatically preserves and routes distinct agentId vs taskId."""
        client = AgentBranchesClient(server_url=self.server_url)

        # 1. create_task returns distinct taskId (e.g. task-XXXX) and agentId (e.g. alpha-XXXX)
        task = client.create_task(
            repo="https://github.com/cf/agent.git",
            base_sha="1111111111111111111111111111111111111111",
            intent="Refactoring auth middleware",
            branch="feat/auth-middleware",
            agent="alpha",
        )
        task_id = task["taskId"]
        agent_id = task["agentId"]
        self.assertTrue(task_id.startswith("task-"))
        self.assertTrue(agent_id.startswith("alpha-"))
        self.assertNotEqual(task_id, agent_id)

        # 2. get_task returns full record with agentId
        task_info = client.get_task(task_id)
        self.assertEqual(task_info["taskId"], task_id)
        self.assertEqual(task_info["agentId"], agent_id)

        # 3. push using task_id automatically resolves agentId and sends it to L1
        push_res = client.push(
            task_id=task_id,
            head_sha="2222222222222222222222222222222222222222",
            base_sha="1111111111111111111111111111111111111111",
            files_changed=["src/auth.ts"],
            intent="WIP auth implementation",
            test_provenance="vitest: 12 passed",
        )
        self.assertTrue(push_res["accepted"])
        self.assertEqual(push_res["agentId"], agent_id)

        # 4. push with explicit agent_id succeeds
        push_agent_direct = client.push(
            agent_id=agent_id,
            head_sha="3333333333333333333333333333333333333333",
            intent="Second commit via agent_id directly",
        )
        self.assertTrue(push_agent_direct["accepted"])
        self.assertEqual(push_agent_direct["agentId"], agent_id)

        # 5. push with unresolvable task_id fails closed with ValueError (never aliases to task_id)
        unregistered_client = AgentBranchesClient(server_url=self.server_url)
        with self.assertRaises(ValueError) as ctx:
            unregistered_client.push(
                task_id="task-non-existent-9999",
                head_sha="4444444444444444444444444444444444444444",
            )
        self.assertIn("Cannot resolve agentId", str(ctx.exception))

        # 6. CLI push with unresolvable task_id exits with code 1 and prints clear error
        res_unresolvable = self.run_cli(
            [
                "push",
                "--task-id",
                "task-fake-unknown",
                "--head-sha",
                "4444444444444444444444444444444444444444",
                "--server",
                self.server_url,
            ],
            check=False,
        )
        self.assertEqual(res_unresolvable.returncode, 1)
        self.assertIn("Cannot resolve agentId", res_unresolvable.stderr)


    def test_03_admin_bearer_token_support(self):
        """Test admin bearer token authentication on task creation."""
        # Spawn an authenticated mock server requiring admin token
        auth_server, auth_thread, auth_url, _ = start_mock_l1_server(
            host="127.0.0.1", port=0, expected_admin_token="secret-admin-token-777"
        )
        try:
            client = AgentBranchesClient(server_url=auth_url)

            # Request without token fails with HTTP 401
            with self.assertRaises(AgentBranchesAPIError) as ctx:
                client.create_task(
                    repo="https://github.com/cf/repo.git",
                    base_sha="0000000000000000000000000000000000000000",
                    intent="Unauthorized attempt",
                    branch="feat/unauth",
                )
            self.assertEqual(ctx.exception.status_code, 401)

            # Request with wrong token fails with HTTP 401
            with self.assertRaises(AgentBranchesAPIError) as ctx:
                client.create_task(
                    repo="https://github.com/cf/repo.git",
                    base_sha="0000000000000000000000000000000000000000",
                    intent="Wrong token attempt",
                    branch="feat/wrong-token",
                    admin_token="wrong-token-xyz",
                )
            self.assertEqual(ctx.exception.status_code, 401)

            # Request with correct admin token succeeds (201 Created)
            task = client.create_task(
                repo="https://github.com/cf/repo.git",
                base_sha="0000000000000000000000000000000000000000",
                intent="Authorized task creation",
                branch="feat/auth-success",
                admin_token="secret-admin-token-777",
            )
            self.assertIn("taskId", task)

            # CLI with --admin-token flag succeeds
            res_cli = self.run_cli([
                "task", "create",
                "--repo", "https://github.com/cf/repo.git",
                "--branch", "feat/cli-token",
                "--server", auth_url,
                "--admin-token", "secret-admin-token-777",
                "--json",
            ])
            data = json.loads(res_cli.stdout)
            self.assertIn("taskId", data)

            # CLI with ADMIN_TOKEN environment variable succeeds
            res_env = self.run_cli(
                [
                    "task", "create",
                    "--repo", "https://github.com/cf/repo.git",
                    "--branch", "feat/cli-env-token",
                    "--server", auth_url,
                    "--json",
                ],
                env_vars={"ADMIN_TOKEN": "secret-admin-token-777"},
            )
            data_env = json.loads(res_env.stdout)
            self.assertIn("taskId", data_env)

            # CLI without token against auth server exits with code 1
            res_fail = self.run_cli(
                [
                    "task", "create",
                    "--repo", "https://github.com/cf/repo.git",
                    "--branch", "feat/cli-no-token",
                    "--server", auth_url,
                ],
                check=False,
            )
            self.assertEqual(res_fail.returncode, 1)
            self.assertIn("401", res_fail.stderr)
        finally:
            auth_server.shutdown()
            auth_server.server_close()

    def test_04_git_utils_robustness(self):
        """Test git_utils error handling, NUL-separated parsing, and None return on failure."""
        head = get_current_head_sha(cwd=self.repo_root)
        self.assertIsNotNone(head)
        self.assertEqual(len(head), 40)

        branch = get_current_branch(cwd=self.repo_root)
        self.assertIsNotNone(branch)

        # 1. Successful git diff returns List[str]
        parent = f"{head}~1" if run_git_cmd(["rev-parse", "--verify", f"{head}~1"], cwd=self.repo_root) else head
        files = get_changed_files(base_sha=parent, head_sha=head, cwd=self.repo_root)
        self.assertIsInstance(files, list)

        # 2. Failed git diff (invalid SHA) returns None, NOT []
        bad_files = get_changed_files(
            base_sha="invalid-sha-00000000000000000000000000",
            head_sha="invalid-sha-11111111111111111111111111",
            cwd=self.repo_root,
        )
        self.assertIsNone(bad_files, "git_utils must return None on diff error, not empty list")

        # 3. Timeout on git diff returns None, NOT []
        timeout_files = get_changed_files(
            base_sha=head, head_sha=head, cwd=self.repo_root, timeout=0.000001
        )
        self.assertIsNone(timeout_files, "git_utils must return None on timeout")

        # 4. run_git_cmd on invalid command returns None
        self.assertIsNone(run_git_cmd(["non-existent-git-subcommand-xyz"]))

    def test_05_cli_end_to_end_flow(self):
        """Test full CLI lifecycle with distinct agentId and taskId."""
        # 1. task create (formatted text)
        res1 = self.run_cli([
            "task", "create",
            "--repo", "https://github.com/test/repo.git",
            "--base-sha", "abcdef1234567890abcdef1234567890abcdef12",
            "--intent", "Refactoring auth middleware to use JWT",
            "--branch", "feat/jwt-auth",
            "--server", self.server_url,
        ])
        self.assertIn("TASK REGISTERED SUCCESSFULLY", res1.stdout)
        self.assertIn("feat/jwt-auth", res1.stdout)
        self.assertIn("Agent ID:", res1.stdout)

        # 2. task create (--json)
        res2 = self.run_cli([
            "task", "create",
            "--repo", "https://github.com/test/repo.git",
            "--base-sha", "abcdef1234567890abcdef1234567890abcdef12",
            "--intent", "Task with JSON output",
            "--branch", "feat/cli-json",
            "--agent", "beta",
            "--server", self.server_url,
            "--json",
        ])
        task_data = json.loads(res2.stdout)
        self.assertIn("taskId", task_data)
        self.assertIn("agentId", task_data)
        task_id = task_data["taskId"]
        agent_id = task_data["agentId"]

        # 3. push WIP using --task-id (resolves agentId)
        res3 = self.run_cli([
            "push",
            "--task-id", task_id,
            "--head-sha", "fedcba0987654321fedcba0987654321fedcba09",
            "--files-changed", "src/auth.ts,src/config.ts",
            "--intent-update", "Updated schema validation",
            "--test-provenance", "vitest: 14 passed",
            "--server", self.server_url,
        ])
        self.assertIn("WIP COMMIT PUSH REGISTERED", res3.stdout)
        self.assertIn(task_id, res3.stdout)

        # 4. push WIP using explicit --agent-id
        res4 = self.run_cli([
            "push",
            "--agent-id", agent_id,
            "--head-sha", "9999990987654321fedcba0987654321fedcba09",
            "--files-changed", "src/auth.ts",
            "--intent-update", "Second WIP push via explicit agent-id",
            "--test-provenance", "vitest: 15 passed",
            "--server", self.server_url,
            "--json",
        ])
        push_data = json.loads(res4.stdout)
        self.assertTrue(push_data["accepted"])
        self.assertEqual(push_data["agentId"], agent_id)

        # 5. global status (formatted text)
        res5 = self.run_cli(["status", "--server", self.server_url])
        self.assertIn("RADAR / COORDINATOR STATUS", res5.stdout)
        self.assertIn(task_id, res5.stdout)

        # 6. task status (formatted text)
        res6 = self.run_cli(["status", "--task-id", task_id, "--server", self.server_url])
        self.assertIn(f"TASK STATUS: {task_id}", res6.stdout)
        self.assertIn("feat/cli-json", res6.stdout)
        self.assertIn("Agent ID:", res6.stdout)

        # 7. task status (--json)
        res7 = self.run_cli(["status", "--task-id", task_id, "--server", self.server_url, "--json"])
        task_status = json.loads(res7.stdout)
        self.assertEqual(task_status["task_id"], task_id)
        self.assertEqual(task_status["agentId"], agent_id)

        # 8. Create conflicting task and trigger radar warning
        res8 = self.run_cli([
            "task", "create",
            "--branch", "feat/conflict-partner",
            "--agent", "gamma",
            "--server", self.server_url,
            "--json",
        ])
        partner = json.loads(res8.stdout)
        partner_id = partner["taskId"]
        partner_agent = partner["agentId"]

        res9 = self.run_cli([
            "push",
            "--agent-id", partner_agent,
            "--head-sha", "7777770987654321fedcba0987654321fedcba09",
            "--files-changed", "src/auth.ts",
            "--intent-update", "Modifying auth concurrently",
            "--server", self.server_url,
            "--json",
        ])
        partner_push = json.loads(res9.stdout)
        self.assertGreaterEqual(len(partner_push["new_warnings"]), 1)
        warn_id = partner_push["new_warnings"][0]["warning_id"]

        # 9. ack warning (formatted text)
        res10 = self.run_cli([
            "ack",
            "--task-id", partner_id,
            "--warning-id", warn_id,
            "--action", "rebased_locally",
            "--server", self.server_url,
        ])
        self.assertIn("WARNING ACKNOWLEDGED", res10.stdout)
        self.assertIn(warn_id, res10.stdout)
        self.assertIn("rebased_locally", res10.stdout)

        # 10. ack warning (--json)
        with self.state.lock:
            w2_id = "warn-cli-json-002"
            self.state.warnings[w2_id] = {
                "warning_id": w2_id,
                "pair": [task_id, partner_id],
                "status": "active",
                "kind": "textual",
            }

        res11 = self.run_cli([
            "ack",
            "--task-id", task_id,
            "--warning-id", w2_id,
            "--action", "manual_merge",
            "--server", self.server_url,
            "--json",
        ])
        ack_data = json.loads(res11.stdout)
        self.assertTrue(ack_data["acknowledged"])
        self.assertEqual(ack_data["action"], "manual_merge")

    def test_06_error_handling_and_validation(self):
        """Test error handling on bad connections, unknown tasks, and bad requests."""
        # 1. Connection error to dead port
        dead_url = "http://127.0.0.1:59999"
        client = AgentBranchesClient(server_url=dead_url, timeout=0.5)
        with self.assertRaises(AgentBranchesConnectionError):
            client.get_status()

        res_conn = self.run_cli(["status", "--server", dead_url], check=False)
        self.assertEqual(res_conn.returncode, 2)
        self.assertIn("Connection Error", res_conn.stderr)

        # 2. Unknown task ID -> 404
        client_live = AgentBranchesClient(server_url=self.server_url)
        with self.assertRaises(AgentBranchesAPIError) as ctx:
            client_live.get_task("task-non-existent-9999")
        self.assertEqual(ctx.exception.status_code, 404)

        res_404 = self.run_cli(
            ["status", "--task-id", "task-99999", "--server", self.server_url], check=False
        )
        self.assertEqual(res_404.returncode, 1)
        self.assertIn("API Error (404)", res_404.stderr)

        # 3. Unknown warning ID -> 404
        with self.assertRaises(AgentBranchesAPIError) as ctx:
            client_live.ack_warning("warn-non-existent", task_id="task-0001")
        self.assertEqual(ctx.exception.status_code, 404)

        res_ack_404 = self.run_cli(
            [
                "ack",
                "--task-id",
                "task-0001",
                "--warning-id",
                "warn-fake-999",
                "--server",
                self.server_url,
            ],
            check=False,
        )
        self.assertEqual(res_ack_404.returncode, 1)
        self.assertIn("API Error (404)", res_ack_404.stderr)

        # 4. Push without task_id or agent_id -> CLI exits with code 2
        res_missing_arg = self.run_cli(["push", "--head-sha", "123"], check=False)
        self.assertEqual(res_missing_arg.returncode, 2)

    def test_07_payload_integrity_and_deduplication(self):
        """Test that push payloads preserve full metadata and duplicate pushes deduplicate."""
        client = AgentBranchesClient(server_url=self.server_url)
        task = client.create_task(
            repo="https://github.com/cf/repo.git",
            base_sha="0000000000000000000000000000000000000000",
            intent="Integrity test task",
            branch="feat/integrity",
        )
        task_id = task["taskId"]
        agent_id = task["agentId"]

        # Push with full metadata
        res = client.push(
            task_id=task_id,
            head_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            base_sha="0000000000000000000000000000000000000000",
            files_changed=["lib/a.py", "lib/b.py"],
            intent="Added integrity tests",
            test_provenance="pytest: 42 passed in 1.2s",
        )
        self.assertTrue(res["accepted"])
        self.assertFalse(res["deduped"])
        self.assertEqual(res["agentId"], agent_id)

        # Verify state in coordinator
        task_record = client.get_task(task_id)
        self.assertEqual(task_record["head_sha"], "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        self.assertEqual(task_record["files_changed"], ["lib/a.py", "lib/b.py"])
        self.assertEqual(task_record["intent"], "Added integrity tests")
        self.assertEqual(task_record["test_provenance"], "pytest: 42 passed in 1.2s")

        # Duplicate push with identical head_sha -> must be deduped
        res_dedup = client.push(
            task_id=task_id,
            head_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        self.assertTrue(res_dedup["accepted"])
        self.assertTrue(res_dedup["deduped"])
        self.assertEqual(res_dedup["radar_checks"], 0)

    def test_08_send_checks_success(self):
        """Test sending CONTRACT v0.1 radar checks returns 200 accepted."""
        client = AgentBranchesClient(server_url=self.server_url)
        t_a = client.create_task(
            repo="https://github.com/cf/repo.git",
            base_sha="0000000000000000000000000000000000000000",
            intent="Checks test agent A",
            branch="feat/chk-a",
            agent="chk-alpha",
        )
        t_b = client.create_task(
            repo="https://github.com/cf/repo.git",
            base_sha="0000000000000000000000000000000000000000",
            intent="Checks test agent B",
            branch="feat/chk-b",
            agent="chk-beta",
        )
        sha_a = "1234567890123456789012345678901234567890"
        sha_b = "9876543210987654321098765432109876543210"

        client.push(task_id=t_a["taskId"], head_sha=sha_a)
        client.push(task_id=t_b["taskId"], head_sha=sha_b)

        v01_payload = {
            "contract": "0.1",
            "vector": {
                t_a["agentId"]: sha_a,
                t_b["agentId"]: sha_b,
            },
            "policy": {
                "merge": "git-merge-tree",
                "tests": {"command": ["npm", "test"], "budget_s": 15.0},
            },
            "coverage": {
                "pairs_checked": 1,
                "tests_collected": 5,
            },
            "results": [
                {
                    "pair": [t_a["agentId"], t_b["agentId"]],
                    "heads": {
                        t_a["agentId"]: sha_a,
                        t_b["agentId"]: sha_b,
                    },
                    "status": "clean",
                    "kind": "textual",
                    "evidence": {
                        "summary": "clean textual merge",
                        "files": [],
                    },
                }
            ],
        }

        res = client.send_checks(v01_payload)
        self.assertEqual(res["accepted"], 1)
        self.assertEqual(len(res["pairs"]), 1)
        self.assertEqual(res["pairs"][0]["status"], "clean")

    def test_09_send_checks_stale_vector_409(self):
        """Test sending checks with a stale head vector raises StaleVectorError (HTTP 409)."""
        client = AgentBranchesClient(server_url=self.server_url)
        t_a = client.create_task(
            repo="https://github.com/cf/repo.git",
            base_sha="0000000000000000000000000000000000000000",
            intent="Stale vector agent A",
            branch="feat/stale-a",
            agent="stale-alpha",
        )
        sha_current = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        sha_stale = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

        client.push(task_id=t_a["taskId"], head_sha=sha_current)

        # Vector specifies sha_stale which does not match coordinator's head sha_current
        stale_payload = {
            "contract": "0.1",
            "vector": {
                t_a["agentId"]: sha_stale,
            },
            "results": [
                {
                    "pair": [t_a["agentId"], "other-agent"],
                    "status": "clean",
                }
            ],
        }

        # 1. Asserts StaleVectorError is raised
        with self.assertRaises(StaleVectorError) as ctx:
            client.send_checks(stale_payload)
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("Head vector is stale", ctx.exception.message)

        # 2. Asserts return_error_dict=True returns structured dict
        err_dict = client.send_checks(stale_payload, return_error_dict=True)
        self.assertEqual(err_dict["error"], "stale_vector")
        self.assertEqual(err_dict["status_code"], 409)

    def test_10_cli_checks_command(self):
        """Test CLI checks command with file input, piped stdin, and stale vector."""
        import tempfile

        client = AgentBranchesClient(server_url=self.server_url)
        t_a = client.create_task(
            repo="https://github.com/cf/repo.git",
            base_sha="0000000000000000000000000000000000000000",
            intent="CLI checks agent A",
            branch="feat/cli-chk-a",
            agent="clichk-alpha",
        )
        t_b = client.create_task(
            repo="https://github.com/cf/repo.git",
            base_sha="0000000000000000000000000000000000000000",
            intent="CLI checks agent B",
            branch="feat/cli-chk-b",
            agent="clichk-beta",
        )
        sha_a = "ffffffffffffffffffffffffffffffffffffffff"
        sha_b = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"

        client.push(task_id=t_a["taskId"], head_sha=sha_a)
        client.push(task_id=t_b["taskId"], head_sha=sha_b)

        valid_payload = {
            "contract": "0.1",
            "vector": {
                t_a["agentId"]: sha_a,
                t_b["agentId"]: sha_b,
            },
            "results": [
                {
                    "pair": [t_a["agentId"], t_b["agentId"]],
                    "status": "conflict",
                    "kind": "textual",
                    "evidence": {"summary": "conflict in auth.ts"},
                }
            ],
        }

        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tf:
            json.dump(valid_payload, tf)
            tf_path = tf.name

        try:
            # 1. CLI checks --file <payload.json>
            res_file = self.run_cli(["checks", "--file", tf_path, "--server", self.server_url])
            self.assertIn("RADAR CHECKS SUBMITTED (CONTRACT v0.1)", res_file.stdout)
            self.assertIn("Accepted:  1 check(s)", res_file.stdout)

            # 2. CLI checks --file <payload.json> --json
            res_json = self.run_cli(
                ["checks", "--file", tf_path, "--server", self.server_url, "--json"]
            )
            data = json.loads(res_json.stdout)
            self.assertEqual(data["accepted"], 1)

            # 3. CLI checks piped via stdin
            res_stdin = self.run_cli(
                ["checks", "--server", self.server_url],
                input_data=json.dumps(valid_payload),
            )
            self.assertIn("RADAR CHECKS SUBMITTED", res_stdin.stdout)

            # 4. CLI checks with stale vector -> exits with code 1
            stale_cli_payload = dict(valid_payload)
            stale_cli_payload["vector"] = {
                t_a["agentId"]: "0000000000000000000000000000000000000000"
            }
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tf_stale:
                json.dump(stale_cli_payload, tf_stale)
                tf_stale_path = tf_stale.name

            try:
                res_stale = self.run_cli(
                    ["checks", "--file", tf_stale_path, "--server", self.server_url],
                    check=False,
                )
                self.assertEqual(res_stale.returncode, 1)
                self.assertIn("409", res_stale.stderr)
                self.assertIn("Stale vector", res_stale.stderr)
            finally:
                if os.path.exists(tf_stale_path):
                    os.remove(tf_stale_path)
        finally:
            if os.path.exists(tf_path):
                os.remove(tf_path)


    def test_11_stale_vector_fail_closed_without_recompute(self):
        """409 StaleVectorError: no recompute_fn => fail closed, old results NEVER replayed."""
        client = AgentBranchesClient(server_url=self.server_url)
        t_a = client.create_task(
            repo="https://github.com/cf/repo.git",
            base_sha="0000000000000000000000000000000000000000",
            intent="Resync agent A",
            branch="feat/resync-a",
            agent="resync-alpha",
        )
        t_b = client.create_task(
            repo="https://github.com/cf/repo.git",
            base_sha="0000000000000000000000000000000000000000",
            intent="Resync agent B",
            branch="feat/resync-b",
            agent="resync-beta",
        )
        sha_a = "1111111111111111111111111111111111111111"
        sha_b = "2222222222222222222222222222222222222222"
        client.push(task_id=t_a["taskId"], head_sha=sha_a)
        client.push(task_id=t_b["taskId"], head_sha=sha_b)

        stale_vector = {
            t_a["agentId"]: "9999999999999999999999999999999999999999",
            t_b["agentId"]: "8888888888888888888888888888888888888888",
        }
        stale_payload = {
            "contract": "0.1",
            "vector": dict(stale_vector),
            "results": [
                {
                    "pair": [t_a["agentId"], t_b["agentId"]],
                    "status": "clean",
                }
            ],
        }

        # 1. Plain send_checks raises StaleVectorError on the stale vector
        with self.assertRaises(StaleVectorError) as ctx:
            client.send_checks(stale_payload)
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("Head vector is stale", ctx.exception.message)

        # 2. refresh_head_vector returns the coordinator's current heads,
        #    keyed by BOTH agentId and taskId (resync source of truth)
        heads = client.refresh_head_vector()
        self.assertEqual(heads[t_a["agentId"]], sha_a)
        self.assertEqual(heads[t_a["taskId"]], sha_a)
        self.assertEqual(heads[t_b["agentId"]], sha_b)
        self.assertEqual(heads[t_b["taskId"]], sha_b)

        # 3. C1479 FAIL CLOSED: without recompute_fn the client must NOT update
        #    the vector and replay the old clean results as if they were fresh.
        counting = _CountingSendClient(server_url=self.server_url)
        with self.assertRaises(StaleVectorError) as ctx:
            counting.send_checks_with_resync(stale_payload)
        self.assertEqual(counting.send_calls, 1, "no retry without re-evaluation")
        self.assertEqual(
            stale_payload["vector"], stale_vector, "input payload must not be mutated"
        )
        # The raised error carries the coordinator's current heads so the
        # caller can explicitly re-evaluate.
        self.assertIsInstance(ctx.exception.fresh_vector, dict)
        self.assertEqual(ctx.exception.fresh_vector[t_a["agentId"]], sha_a)
        self.assertEqual(ctx.exception.fresh_vector[t_b["agentId"]], sha_b)

        # 4. Even after heads move, the old results are still not replayed
        client.push(task_id=t_b["taskId"], head_sha="3333333333333333333333333333333333333333")
        counting2 = _CountingSendClient(server_url=self.server_url)
        with self.assertRaises(StaleVectorError) as ctx:
            counting2.send_checks_with_resync(stale_payload)
        self.assertEqual(counting2.send_calls, 1)
        self.assertEqual(ctx.exception.fresh_vector[t_b["agentId"]],
                         "3333333333333333333333333333333333333333")

        # 5. max_attempts=1 still attaches the fresh vector, but never resends
        class _CountingClient(_CountingSendClient):
            def __init__(self, **kw):
                super().__init__(**kw)
                self.refresh_calls = 0

            def refresh_head_vector(self, runner_token=None):
                self.refresh_calls += 1
                return super().refresh_head_vector(runner_token=runner_token)

        counter = _CountingClient(server_url=self.server_url)
        with self.assertRaises(StaleVectorError):
            counter.send_checks_with_resync(stale_payload, max_attempts=1)
        self.assertEqual(counter.send_calls, 1)
        self.assertEqual(counter.refresh_calls, 1)

        # 6. Loop bound WITH recompute_fn: exactly N attempts (N >= 2), and the
        #    raised error carries the last fresh vector
        def recompute_generic(current_heads):
            return {
                "contract": "0.1",
                "vector": dict(current_heads),
                "results": [],
            }

        always_stale = _AlwaysStaleClient(fresh_heads={"agent-x": "fresh-sha"})
        with self.assertRaises(StaleVectorError) as ctx:
            always_stale.send_checks_with_resync(
                {"contract": "0.1", "vector": {"agent-x": "stale-sha"}, "results": []},
                max_attempts=3,
                recompute_fn=recompute_generic,
            )
        self.assertIn("unit-stub", ctx.exception.message)
        self.assertEqual(always_stale.send_calls, 3)
        self.assertEqual(always_stale.refresh_calls, 3)

        # 7. Fail closed on missing participants: an agent the coordinator no
        #    longer knows triggers one resync, then raises without retrying
        #    with a silently pruned vector
        blind = _AlwaysStaleClient(fresh_heads={"known-agent": "fresh-sha"})
        with self.assertRaises(StaleVectorError) as ctx:
            blind.send_checks_with_resync(
                {"contract": "0.1", "vector": {"ghost-agent": "sha"}, "results": []},
                recompute_fn=recompute_generic,
            )
        self.assertEqual(blind.send_calls, 1)
        self.assertEqual(blind.refresh_calls, 1)
        self.assertEqual(ctx.exception.fresh_vector, {"known-agent": "fresh-sha"})

        # 8. Missing/invalid vector: resync read still happens (fresh vector is
        #    attached) but no recompute or retry is attempted
        no_vector = _AlwaysStaleClient(fresh_heads={"agent-x": "fresh-sha"})
        with self.assertRaises(StaleVectorError):
            no_vector.send_checks_with_resync({"contract": "0.1", "results": []})
        self.assertEqual(no_vector.send_calls, 1)
        self.assertEqual(no_vector.refresh_calls, 1)

    def test_12_token_expiry_401_reported_and_halt(self):
        """Correct-but-expired tokens yield 401 TokenExpiredError; client halts (no retry)."""
        expired_ts = time.time() - 3600.0
        exp_srv, exp_thread, exp_url, _exp_state = start_mock_l1_server(
            host="127.0.0.1",
            port=0,
            expected_admin_token="adm-expired-token",
            expected_runner_token="run-expired-token",
            admin_token_expires_at=expired_ts,
            runner_token_expires_at=expired_ts,
        )
        try:
            client = AgentBranchesClient(server_url=exp_url)

            # 1. Correct admin token past its expiry -> TokenExpiredError with evidence
            with self.assertRaises(TokenExpiredError) as ctx:
                client.create_task(
                    repo="https://github.com/cf/repo.git",
                    base_sha="0000000000000000000000000000000000000000",
                    intent="Expired admin token attempt",
                    branch="feat/expired-admin",
                    admin_token="adm-expired-token",
                )
            self.assertEqual(ctx.exception.status_code, 401)
            self.assertIn("expired", ctx.exception.message.lower())
            self.assertIsInstance(ctx.exception.payload, dict)
            self.assertEqual(ctx.exception.payload.get("error"), "token_expired")
            self.assertIn("expires_at", ctx.exception.payload)
            reported = datetime.datetime.fromisoformat(ctx.exception.payload["expires_at"])
            self.assertLess(
                reported.timestamp(),
                time.time(),
                "expires_at must reflect the simulated past expiry",
            )

            # 2. Client halts: immediate retries fail identically, no silent refresh
            for _ in range(2):
                with self.assertRaises(TokenExpiredError):
                    client.create_task(
                        repo="https://github.com/cf/repo.git",
                        base_sha="0000000000000000000000000000000000000000",
                        intent="Expired admin token retry",
                        branch="feat/expired-admin",
                        admin_token="adm-expired-token",
                    )

            # 3. Expired runner token on POST /checks -> TokenExpiredError, halts
            checks_payload = {
                "contract": "0.1",
                "vector": {"unknown-agent": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
                "results": [],
            }
            for _ in range(2):
                with self.assertRaises(TokenExpiredError) as ctx:
                    client.send_checks(checks_payload, runner_token="run-expired-token")
                self.assertEqual(ctx.exception.status_code, 401)
                self.assertIn("expired", ctx.exception.message.lower())

            # 4. CLI reports expired credentials clearly and halts non-zero
            res = self.run_cli(
                [
                    "task", "create",
                    "--repo", "https://github.com/cf/repo.git",
                    "--branch", "feat/expired-cli",
                    "--server", exp_url,
                    "--admin-token", "adm-expired-token",
                ],
                check=False,
            )
            self.assertEqual(res.returncode, 1)
            self.assertIn("expired", res.stderr.lower())
            self.assertIn("Halting", res.stderr)
        finally:
            exp_srv.shutdown()
            exp_srv.server_close()

        # 5. Timestamps are honored: a token with a FUTURE expiry is accepted
        future_ts = time.time() + 3600.0
        fut_srv, fut_thread, fut_url, _fut_state = start_mock_l1_server(
            host="127.0.0.1",
            port=0,
            expected_admin_token="adm-future-token",
            admin_token_expires_at=future_ts,
        )
        try:
            ok_client = AgentBranchesClient(server_url=fut_url)
            task = ok_client.create_task(
                repo="https://github.com/cf/repo.git",
                base_sha="0000000000000000000000000000000000000000",
                intent="Future expiry accepted",
                branch="feat/future-expiry",
                admin_token="adm-future-token",
            )
            self.assertIn("taskId", task)

            # Wrong token stays a generic 401, not classified as expired/revoked
            with self.assertRaises(AgentBranchesAPIError) as ctx:
                ok_client.create_task(
                    repo="https://github.com/cf/repo.git",
                    base_sha="0000000000000000000000000000000000000000",
                    intent="Wrong token attempt",
                    branch="feat/wrong-token",
                    admin_token="never-issued-token",
                )
            self.assertEqual(ctx.exception.status_code, 401)
            self.assertNotIsInstance(ctx.exception, (TokenExpiredError, TokenRevokedError))
        finally:
            fut_srv.shutdown()
            fut_srv.server_close()

    def test_13_token_revocation_403_fail_closed(self):
        """Revoked tokens yield 403 TokenRevokedError; fail closed, never retried."""
        revoked_srv, revoked_thread, revoked_url, revoked_state = start_mock_l1_server(
            host="127.0.0.1",
            port=0,
            expected_admin_token="adm-live-token",
            expected_runner_token="run-live-token",
            runner_token_expires_at=time.time() - 60.0,  # expired AND revoked below
        )
        try:
            client = AgentBranchesClient(server_url=revoked_url)

            # Sanity: token valid before revocation (runner token expires, admin does not)
            task = client.create_task(
                repo="https://github.com/cf/repo.git",
                base_sha="0000000000000000000000000000000000000000",
                intent="Pre-revocation task",
                branch="feat/pre-revoke",
                admin_token="adm-live-token",
            )
            self.assertIn("taskId", task)

            # 1. Revoke admin token mid-flight -> next request 403 TokenRevokedError
            revoked_at = revoked_state.revoke_token("adm-live-token")
            with self.assertRaises(TokenRevokedError) as ctx:
                client.create_task(
                    repo="https://github.com/cf/repo.git",
                    base_sha="0000000000000000000000000000000000000000",
                    intent="Post-revocation attempt",
                    branch="feat/post-revoke",
                    admin_token="adm-live-token",
                )
            self.assertEqual(ctx.exception.status_code, 403)
            self.assertIn("revoked", ctx.exception.message.lower())
            self.assertIsInstance(ctx.exception.payload, dict)
            self.assertEqual(ctx.exception.payload.get("error"), "token_revoked")
            self.assertEqual(ctx.exception.payload.get("revoked_at"), revoked_at)

            # 2. Fail closed: repeated attempts keep raising; no retry succeeds
            for _ in range(3):
                with self.assertRaises(TokenRevokedError):
                    client.create_task(
                        repo="https://github.com/cf/repo.git",
                        base_sha="0000000000000000000000000000000000000000",
                        intent="Post-revocation retry",
                        branch="feat/post-revoke",
                        admin_token="adm-live-token",
                    )

            # 3. Revocation takes precedence over expiry on the runner token
            revoked_state.revoke_token("run-live-token")
            checks_payload = {
                "contract": "0.1",
                "vector": {task["agentId"]: "9999999999999999999999999999999999999999"},
                "results": [
                    {"pair": [task["agentId"], "other-agent"], "status": "clean"}
                ],
            }
            with self.assertRaises(TokenRevokedError) as ctx:
                client.send_checks(checks_payload, runner_token="run-live-token")
            self.assertEqual(ctx.exception.status_code, 403)
            self.assertIn("revoked", ctx.exception.message.lower())

            # 4. The resync loop never swallows or retries auth failures
            with self.assertRaises(TokenRevokedError):
                client.send_checks_with_resync(
                    checks_payload, runner_token="run-live-token", max_attempts=5
                )

            # 5. CLI checks with revoked runner token exits non-zero, names revocation
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tf:
                json.dump(checks_payload, tf)
                tf_path = tf.name
            try:
                res = self.run_cli(
                    [
                        "checks",
                        "--file", tf_path,
                        "--server", revoked_url,
                        "--runner-token", "run-live-token",
                    ],
                    check=False,
                )
                self.assertEqual(res.returncode, 1)
                self.assertIn("revoked", res.stderr.lower())
                self.assertIn("failing closed", res.stderr.lower())
            finally:
                if os.path.exists(tf_path):
                    os.remove(tf_path)
        finally:
            revoked_srv.shutdown()
            revoked_srv.server_close()

    def test_14_resync_recompute_paths_real_server(self):
        """C1479: resync only retries with recompute_fn; stale evidence is never relabeled."""
        client = AgentBranchesClient(server_url=self.server_url)
        t_a = client.create_task(
            repo="https://github.com/cf/repo.git",
            base_sha="0000000000000000000000000000000000000000",
            intent="Recompute agent A",
            branch="feat/recompute-a",
            agent="recompute-alpha",
        )
        t_b = client.create_task(
            repo="https://github.com/cf/repo.git",
            base_sha="0000000000000000000000000000000000000000",
            intent="Recompute agent B",
            branch="feat/recompute-b",
            agent="recompute-beta",
        )
        sha_a = "aaaa111111111111111111111111111111111111"
        sha_b_old = "bbbb222222222222222222222222222222222222"
        client.push(task_id=t_a["taskId"], head_sha=sha_a)
        client.push(task_id=t_b["taskId"], head_sha=sha_b_old)

        stale_vector = {
            t_a["agentId"]: "9999000000000000000000000000000000000000",
            t_b["agentId"]: "8888000000000000000000000000000000000000",
        }
        stale_payload = {
            "contract": "0.1",
            "vector": dict(stale_vector),
            "results": [
                {
                    "pair": [t_a["agentId"], t_b["agentId"]],
                    "status": "clean",
                }
            ],
        }
        # Heads move while the runner is evaluating: the old "clean" result is
        # now computed against a superseded head.
        sha_b_new = "bbbb333333333333333333333333333333333333"
        client.push(task_id=t_b["taskId"], head_sha=sha_b_new)

        # (a) GENUINE recompute: callback re-evaluates at the fresh vector and
        #     the retry succeeds; the callback receives the CURRENT heads.
        seen_heads = {}

        def recompute_genuine(current_heads):
            seen_heads.update(current_heads)
            return {
                "contract": "0.1",
                "vector": {
                    t_a["agentId"]: current_heads[t_a["agentId"]],
                    t_b["agentId"]: current_heads[t_b["agentId"]],
                },
                "results": [
                    {
                        "pair": [t_a["agentId"], t_b["agentId"]],
                        "status": "re-evaluated-clean",
                    }
                ],
            }

        counting = _CountingSendClient(server_url=self.server_url)
        res = counting.send_checks_with_resync(stale_payload, recompute_fn=recompute_genuine)
        self.assertEqual(counting.send_calls, 2, "initial 409 + one recomputed retry")
        self.assertEqual(res["accepted"], 1)
        self.assertEqual(seen_heads[t_b["agentId"]], sha_b_new, "recompute got CURRENT heads")
        self.assertEqual(
            stale_payload["vector"], stale_vector, "input payload must not be mutated"
        )

        # (b) FAKED recompute: callback returns the payload with the OLD stale
        #     sha relabeled into the vector -> fail closed, never submitted.
        def recompute_fake(current_heads):
            return {
                "contract": "0.1",
                "vector": {
                    t_a["agentId"]: current_heads[t_a["agentId"]],
                    t_b["agentId"]: sha_b_old,  # stale sha smuggled back in
                },
                "results": [
                    {"pair": [t_a["agentId"], t_b["agentId"]], "status": "clean"}
                ],
            }

        counting_b = _CountingSendClient(server_url=self.server_url)
        with self.assertRaises(StaleVectorError):
            counting_b.send_checks_with_resync(stale_payload, recompute_fn=recompute_fake)
        self.assertEqual(counting_b.send_calls, 1, "stale-sha recompute must not be sent")

        # (c) Missing participant: recompute drops agent B from the vector
        #     -> fail closed, never retry with a pruned vector.
        def recompute_drops(current_heads):
            return {
                "contract": "0.1",
                "vector": {t_a["agentId"]: current_heads[t_a["agentId"]]},
                "results": [],
            }

        counting_c = _CountingSendClient(server_url=self.server_url)
        with self.assertRaises(StaleVectorError):
            counting_c.send_checks_with_resync(stale_payload, recompute_fn=recompute_drops)
        self.assertEqual(counting_c.send_calls, 1)

        # (d) recompute_fn raises -> fail closed, stale results never replayed.
        def recompute_boom(current_heads):
            raise RuntimeError("evaluator crashed")

        counting_d = _CountingSendClient(server_url=self.server_url)
        with self.assertRaises(StaleVectorError):
            counting_d.send_checks_with_resync(stale_payload, recompute_fn=recompute_boom)
        self.assertEqual(counting_d.send_calls, 1)

        # (e) Recomputed result references an unknown participant -> fail closed.
        def recompute_ghost_pair(current_heads):
            return {
                "contract": "0.1",
                "vector": {
                    t_a["agentId"]: current_heads[t_a["agentId"]],
                    t_b["agentId"]: current_heads[t_b["agentId"]],
                },
                "results": [
                    {"pair": [t_a["agentId"], "ghost-agent"], "status": "clean"}
                ],
            }

        counting_e = _CountingSendClient(server_url=self.server_url)
        with self.assertRaises(StaleVectorError):
            counting_e.send_checks_with_resync(stale_payload, recompute_fn=recompute_ghost_pair)
        self.assertEqual(counting_e.send_calls, 1)

    def test_15_status_reads_carry_runner_token(self):
        """C1479: GET /status (resync source) is read with the runner bearer token."""
        srv = _StatusAuthServer(("127.0.0.1", 0), MockCoordinatorState())
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{srv.server_address[1]}"
        try:
            client = AgentBranchesClient(server_url=url)
            task = client.create_task(
                repo="https://github.com/cf/repo.git",
                base_sha="0000000000000000000000000000000000000000",
                intent="Authed status read",
                branch="feat/authed-status",
                agent="status-auth",
            )
            client.push(task_id=task["taskId"], head_sha="abcdefabcdefabcdefabcdefabcdefabcdefab")

            # 1. Unauthenticated GET /status is rejected by the coordinator
            with self.assertRaises(AgentBranchesAPIError) as ctx:
                client.get_status()
            self.assertEqual(ctx.exception.status_code, 401)

            # 2. Authenticated read succeeds
            status = client.get_status(runner_token="run-status-token")
            self.assertIn("tasks", status)

            # 3. refresh_head_vector without a token fails closed (401)
            with self.assertRaises(AgentBranchesAPIError) as ctx:
                client.refresh_head_vector()
            self.assertEqual(ctx.exception.status_code, 401)

            # 4. refresh_head_vector with the runner token returns current heads
            heads = client.refresh_head_vector(runner_token="run-status-token")
            self.assertEqual(heads[task["agentId"]], "abcdefabcdefabcdefabcdefabcdefabcdefab")
            self.assertEqual(heads[task["taskId"]], "abcdefabcdefabcdefabcdefabcdefabcdefab")

            # 5. $RUNNER_TOKEN env fallback also authenticates status reads
            old_env = os.environ.get("RUNNER_TOKEN")
            os.environ["RUNNER_TOKEN"] = "run-status-token"
            try:
                status = client.get_status()
                self.assertIn("tasks", status)
            finally:
                if old_env is None:
                    os.environ.pop("RUNNER_TOKEN", None)
                else:
                    os.environ["RUNNER_TOKEN"] = old_env
        finally:
            srv.shutdown()
            srv.server_close()

    def test_16_refresh_head_vector_wire_compatibility_and_recomputation_boundary(self):
        """C1494: refresh_head_vector parses real coordinator StatusResult shape (heads and agents).

        Validates:
        1. Negative test: Status payload missing both 'heads' and 'tasks' returns empty dict (no false heads).
        2. Real coordinator wire format (coordinator.ts lines 95-110): returns 'heads' and 'agents',
           without any top-level 'tasks' key. refresh_head_vector successfully maps both agentId -> head_sha
           and taskId -> head_sha.
        3. Backward compatibility: Mock servers returning top-level 'tasks' remain supported.
        4. Recomputation boundary: Client validates structural schema and participant head freshness;
           semantic validity and merge conflict detection are enforced by the coordinator server 409 gate.
        """
        # 1. Real coordinator StatusResult shape (coordinator.ts lines 95-110, commit 2302d70)
        real_status_payload = {
            "canonical": {"name": "test-repo", "remote": "origin"},
            "agents": [
                {
                    "agentId": "agent-alpha-001",
                    "taskId": "task-alpha-001",
                    "intent": "implement wire fix",
                    "baseSha": "1111111111111111111111111111111111111111",
                    "head": "2222222222222222222222222222222222222222",
                },
                {
                    "agentId": "agent-beta-002",
                    "taskId": "task-beta-002",
                    "intent": "implement review fix",
                    "baseSha": "3333333333333333333333333333333333333333",
                    "head": "4444444444444444444444444444444444444444",
                },
            ],
            "heads": {
                "agent-alpha-001": "2222222222222222222222222222222222222222",
                "agent-beta-002": "4444444444444444444444444444444444444444",
            },
            "pairs": [],
            "warnings": [],
            "radarLog": [],
            "lastRunnerReport": None,
            "unprocessedPushes": [],
        }

        class MockRealStatusClient(AgentBranchesClient):
            def __init__(self, status_payload):
                super().__init__(server_url="http://127.0.0.1:9")
                self._mock_status = status_payload

            def get_status(self, runner_token=None):
                return self._mock_status

        # Verify real wire format: both agentId and taskId resolve to fresh SHAs
        client = MockRealStatusClient(real_status_payload)
        heads = client.refresh_head_vector()
        self.assertEqual(heads["agent-alpha-001"], "2222222222222222222222222222222222222222")
        self.assertEqual(heads["task-alpha-001"], "2222222222222222222222222222222222222222")
        self.assertEqual(heads["agent-beta-002"], "4444444444444444444444444444444444444444")
        self.assertEqual(heads["task-beta-002"], "4444444444444444444444444444444444444444")

        # 2. Negative test: empty or invalid status returns empty dict (fail-closed, never fabricates heads)
        empty_client = MockRealStatusClient({"canonical": {}, "warnings": []})
        self.assertEqual(empty_client.refresh_head_vector(), {})

        # 3. Client recomputation validation boundary:
        # Recomputed payload matching fresh heads passes client schema validation
        valid_recomputed = {
            "contract": "0.1",
            "vector": {
                "agent-alpha-001": "2222222222222222222222222222222222222222",
                "agent-beta-002": "4444444444444444444444444444444444444444",
            },
            "results": [
                {
                    "pair": ["agent-alpha-001", "agent-beta-002"],
                    "status": "clean",
                    "kind": "textual",
                }
            ],
        }
        res = AgentBranchesClient._validated_recomputed_payload(
            original_vector={"agent-alpha-001": "old-sha", "agent-beta-002": "old-sha"},
            fresh_heads=heads,
            recomputed=valid_recomputed,
        )
        self.assertIsNotNone(res)
        self.assertEqual(res["vector"]["agent-alpha-001"], "2222222222222222222222222222222222222222")

        # But recomputed payload with stale SHA fails client validation
        stale_recomputed = dict(valid_recomputed)
        stale_recomputed["vector"] = {
            "agent-alpha-001": "old-sha-still-stale",
            "agent-beta-002": "4444444444444444444444444444444444444444",
        }
        res_stale = AgentBranchesClient._validated_recomputed_payload(
            original_vector={"agent-alpha-001": "old-sha", "agent-beta-002": "old-sha"},
            fresh_heads=heads,
            recomputed=stale_recomputed,
        )
        self.assertIsNone(res_stale)


    def test_17_get_task_auth_owner_or_admin(self):
        """C1499: authenticated GET /tasks/:id detail reads and auto token cache.

        Ladder against a token-configured mock (mirrors proto/auth-reads
        decideReadAuth narrowed to the task owner, commit 2302d70):
        anonymous -> 401, owner task token -> 200, admin -> 200, foreign agent
        token -> 403, runner -> 401 (RUNNER_TOKEN is a read credential on
        unnarrowed reads only per prototype/src/core/auth.ts decideReadAuth;
        the C1499 brief's "runner -> 403" does not match the router it cites).
        Also covers: create_task auto-caches the minted token (get_task and
        push's agent resolution then authenticate without an explicit token),
        the $TASK_TOKEN env fallback, and auth-before-existence (valid
        credential on an unknown task still reaches the 404).
        """
        saved_task_token = os.environ.get("TASK_TOKEN")
        saved_admin_token = os.environ.get("ADMIN_TOKEN")
        os.environ.pop("TASK_TOKEN", None)
        os.environ.pop("ADMIN_TOKEN", None)
        auth_srv, auth_thread, auth_url, _auth_state = start_mock_l1_server(
            host="127.0.0.1",
            port=0,
            expected_admin_token="adm-get-task-token",
            expected_runner_token="run-get-task-token",
        )
        try:
            client = AgentBranchesClient(server_url=auth_url)
            task = client.create_task(
                repo="https://github.com/cf/repo.git",
                base_sha="0000000000000000000000000000000000000000",
                intent="Get-task auth ladder",
                branch="feat/get-task-auth",
                agent="ladder-alpha",
                admin_token="adm-get-task-token",
            )
            task_id = task["taskId"]
            owner_token = task["token"]["plaintext"]  # C1509: wire object {scope, expiresAt, plaintext}
            self.assertTrue(owner_token, "create_task must return the minted task token")
            self.assertEqual(client.task_tokens[task_id], owner_token)

            foreign = client.create_task(
                repo="https://github.com/cf/repo.git",
                base_sha="0000000000000000000000000000000000000000",
                intent="Foreign reader",
                branch="feat/get-task-foreign",
                agent="ladder-beta",
                admin_token="adm-get-task-token",
            )
            foreign_token = foreign["token"]["plaintext"]
            self.assertNotEqual(owner_token, foreign_token)

            # 1. Unauthenticated read -> 401 (the regression the fix addresses)
            anon = AgentBranchesClient(server_url=auth_url)
            with self.assertRaises(AgentBranchesAPIError) as ctx:
                anon.get_task(task_id)
            self.assertEqual(ctx.exception.status_code, 401)

            # 2. Explicit owner task token -> 200
            rec = client.get_task(task_id, token=owner_token)
            self.assertEqual(rec["taskId"], task_id)
            self.assertEqual(rec["agentId"], task["agentId"])

            # 3. Explicit admin token -> 200
            rec_admin = client.get_task(task_id, token="adm-get-task-token")
            self.assertEqual(rec_admin["taskId"], task_id)

            # 4. Runner token on a narrowed task read -> 401 (not a read
            #    credential here; decideReadAuth accepts it on /status only)
            with self.assertRaises(AgentBranchesAPIError) as ctx:
                client.get_task(task_id, token="run-get-task-token")
            self.assertEqual(ctx.exception.status_code, 401)
            self.assertNotIsInstance(ctx.exception, (TokenExpiredError, TokenRevokedError))

            # 5. Valid foreign agent token -> 403 (cross-agent read rejected)
            with self.assertRaises(AgentBranchesAPIError) as ctx:
                client.get_task(task_id, token=foreign_token)
            self.assertEqual(ctx.exception.status_code, 403)
            self.assertIn("forbidden", ctx.exception.message.lower())

            # 6. Auto token resolution: create_task then get_task with no
            #    explicit token reads as the owning agent
            auto = AgentBranchesClient(server_url=auth_url)
            own = auto.create_task(
                repo="https://github.com/cf/repo.git",
                base_sha="0000000000000000000000000000000000000000",
                intent="Auto token resolution",
                branch="feat/get-task-auto",
                agent="ladder-gamma",
                admin_token="adm-get-task-token",
            )
            rec_auto = auto.get_task(own["taskId"])
            self.assertEqual(rec_auto["taskId"], own["taskId"])
            self.assertEqual(rec_auto["agentId"], own["agentId"])

            # 7. push() without agent_id resolves it via the authenticated
            #    get_task path when the task_to_agent cache is empty
            auto.task_to_agent.pop(own["taskId"])
            push_res = auto.push(
                task_id=own["taskId"],
                head_sha="cccccccccccccccccccccccccccccccccccccccc",
            )
            self.assertTrue(push_res["accepted"])
            self.assertEqual(push_res["agentId"], own["agentId"])

            # 8. $TASK_TOKEN env fallback authenticates a client with no cache
            os.environ["TASK_TOKEN"] = owner_token
            try:
                env_client = AgentBranchesClient(server_url=auth_url)
                rec_env = env_client.get_task(task_id)
                self.assertEqual(rec_env["taskId"], task_id)
            finally:
                os.environ.pop("TASK_TOKEN", None)

            # 9. Auth resolves before existence: valid credential on an
            #    unknown task still reaches the coordinator's 404
            with self.assertRaises(AgentBranchesAPIError) as ctx:
                client.get_task("task-non-existent-9999", token=owner_token)
            self.assertEqual(ctx.exception.status_code, 404)

            # 10. Cache is per-task: auto's cached ladder-gamma token is not
            #     replayed against ladder-beta's (uncached) task — the read
            #     fails closed as anonymous (401), never with the wrong
            #     credential (which would surface as 403)
            with self.assertRaises(AgentBranchesAPIError) as ctx:
                auto.get_task(foreign["taskId"])
            self.assertEqual(ctx.exception.status_code, 401)
        finally:
            if saved_task_token is None:
                os.environ.pop("TASK_TOKEN", None)
            else:
                os.environ["TASK_TOKEN"] = saved_task_token
            if saved_admin_token is None:
                os.environ.pop("ADMIN_TOKEN", None)
            else:
                os.environ["ADMIN_TOKEN"] = saved_admin_token
            auth_srv.shutdown()
            auth_srv.server_close()


    def test_18_create_task_token_wire_normalization(self):
        """C1509: the real coordinator CreateTaskResult mints the token as an
        object {scope, expiresAt, plaintext}), fork as {name, remote}, and
        ref at the TOP LEVEL of the result (C1515 — a nested fork.ref was a
        mock artifact).
        The client must cache the plaintext STRING (never the dict) so
        get_task sends exactly 'Bearer <plaintext>' on the wire, flatten the
        fork object into fork_remote/fork_ref, and keep legacy coordinators
        that answer with the flat plaintext string working end to end."""
        auth_srv, _t, auth_url, auth_state = start_mock_l1_server(
            host="127.0.0.1",
            port=0,
            expected_admin_token="adm-wire-token",
        )
        try:
            client = AgentBranchesClient(server_url=auth_url)
            task = client.create_task(
                repo="https://github.com/cf/repo.git",
                base_sha="0000000000000000000000000000000000000000",
                intent="Wire normalization",
                branch="feat/wire-token",
                agent="wire-alpha",
                admin_token="adm-wire-token",
            )
            # Real wire shape arrives as the minted-token object.
            self.assertIsInstance(task["token"], dict)
            self.assertEqual(task["token"]["scope"], f"task:{task['taskId']}")
            self.assertIsInstance(task["token"]["expiresAt"], int)
            plaintext = task["token"]["plaintext"]
            self.assertIsInstance(plaintext, str)

            # The client cached the plaintext STRING, not the dict.
            self.assertIsInstance(client.task_tokens[task["taskId"]], str)
            self.assertEqual(client.task_tokens[task["taskId"]], plaintext)

            # get_task authenticates with the EXACT Bearer <plaintext> header
            # (a dict would render as "Bearer {'scope': ...}" and 401).
            rec = client.get_task(task["taskId"])
            self.assertEqual(rec["taskId"], task["taskId"])
            self.assertEqual(auth_state.last_authorization, f"Bearer {plaintext}")

            # C1515: ref is TOP LEVEL on the real CreateTaskResult wire, not
            # nested inside fork; the client resolves fork_ref from top level.
            self.assertEqual(task["ref"], "refs/heads/feat/wire-token")
            self.assertNotIn("ref", task["fork"])
            self.assertEqual(task["fork_ref"], task["ref"])
            self.assertEqual(task["fork_remote"], task["fork"]["remote"])

            # Legacy compatibility: a coordinator answering with the flat
            # plaintext string still caches and authenticates owner reads.
            legacy_srv, _lt, legacy_url, legacy_state = start_mock_l1_server(
                host="127.0.0.1",
                port=0,
                expected_admin_token="adm-legacy-token",
                token_wire_object=False,
            )
            try:
                legacy = AgentBranchesClient(server_url=legacy_url)
                legacy_task = legacy.create_task(
                    repo="https://github.com/cf/repo.git",
                    base_sha="0000000000000000000000000000000000000000",
                    intent="Legacy string token",
                    branch="feat/legacy-token",
                    agent="legacy-alpha",
                    admin_token="adm-legacy-token",
                )
                self.assertIsInstance(legacy_task["token"], str)
                self.assertEqual(legacy.task_tokens[legacy_task["taskId"]], legacy_task["token"])
                legacy_rec = legacy.get_task(legacy_task["taskId"])
                self.assertEqual(legacy_rec["taskId"], legacy_task["taskId"])
                self.assertEqual(legacy_state.last_authorization, f"Bearer {legacy_task['token']}")
            finally:
                legacy_srv.shutdown()
                legacy_srv.server_close()
        finally:
            auth_srv.shutdown()
            auth_srv.server_close()

    def test_19_push_mutating_bearer_auth(self):
        """C1518: public push() forwards mutating bearer auth (C1517 finding).

        Against a token-configured mock mirroring the real coordinator's
        requireMutatingAuth on POST /events/push: the cached per-task token
        rides as exactly 'Bearer <plaintext>' on the wire (header captured by
        the mock), explicit token= and admin_token= authenticate a cache-less
        client, and with no token available anywhere (no args, no cache, no
        $ADMIN_TOKEN) the bare POST is rejected 401. A valid foreign agent
        token is 403.
        """
        saved_admin = os.environ.get("ADMIN_TOKEN")
        os.environ.pop("ADMIN_TOKEN", None)
        srv, _t, url, state = start_mock_l1_server(
            host="127.0.0.1",
            port=0,
            expected_admin_token="adm-push-token",
            expected_runner_token="run-push-token",
        )
        try:
            owner = AgentBranchesClient(server_url=url)
            task = owner.create_task(
                repo="https://github.com/cf/repo.git",
                base_sha="0000000000000000000000000000000000000000",
                intent="Push auth",
                branch="feat/push-auth",
                agent="push-alpha",
                admin_token="adm-push-token",
            )
            task_id = task["taskId"]
            plaintext = task["token"]["plaintext"]
            agent = task["agentId"]

            # 1. Cached-token path: public push() with no explicit token sends
            #    exactly 'Bearer <plaintext>' and is accepted.
            res = owner.push(task_id=task_id, head_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            self.assertTrue(res["accepted"])
            self.assertEqual(state.last_authorization, f"Bearer {plaintext}")

            # 2. Explicit token= on a cache-less client authenticates.
            bare = AgentBranchesClient(server_url=url)
            res = bare.push(
                task_id=task_id,
                agent_id=agent,
                head_sha="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                token=plaintext,
            )
            self.assertTrue(res["accepted"])
            self.assertEqual(state.last_authorization, f"Bearer {plaintext}")

            # 3. admin_token= parameter authenticates (admin is a push
            #    credential per decideMutatingAuth).
            res = bare.push(
                task_id=task_id,
                agent_id=agent,
                head_sha="cccccccccccccccccccccccccccccccccccccccc",
                admin_token="adm-push-token",
            )
            self.assertTrue(res["accepted"])
            self.assertEqual(state.last_authorization, "Bearer adm-push-token")

            # 4. $ADMIN_TOKEN env fallback authenticates a cache-less client.
            os.environ["ADMIN_TOKEN"] = "adm-push-token"
            try:
                res = bare.push(
                    task_id=task_id,
                    agent_id=agent,
                    head_sha="dddddddddddddddddddddddddddddddddddddddd",
                )
                self.assertTrue(res["accepted"])
                self.assertEqual(state.last_authorization, "Bearer adm-push-token")
            finally:
                os.environ.pop("ADMIN_TOKEN", None)

            # 5. NEGATIVE: no token available anywhere -> the POST goes out
            #    headerless and the coordinator rejects it with 401
            #    requireMutatingAuth (the C1517 regression, now asserted).
            with self.assertRaises(AgentBranchesAPIError) as ctx:
                bare.push(
                    task_id=task_id,
                    agent_id=agent,
                    head_sha="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                )
            self.assertEqual(ctx.exception.status_code, 401)
            self.assertIsNone(state.last_authorization)

            # 6. A valid token for a DIFFERENT agent is 403 (cross-agent
            #    push rejected), matching decideMutatingAuth narrowing.
            foreign = owner.create_task(
                repo="https://github.com/cf/repo.git",
                base_sha="0000000000000000000000000000000000000000",
                intent="Foreign pusher",
                branch="feat/push-foreign",
                agent="push-beta",
                admin_token="adm-push-token",
            )
            with self.assertRaises(AgentBranchesAPIError) as ctx:
                bare.push(
                    task_id=task_id,
                    agent_id=agent,
                    head_sha="ffffffffffffffffffffffffffffffffffffffff",
                    token=foreign["token"]["plaintext"],
                )
            self.assertEqual(ctx.exception.status_code, 403)
        finally:
            if saved_admin is None:
                os.environ.pop("ADMIN_TOKEN", None)
            else:
                os.environ["ADMIN_TOKEN"] = saved_admin
            srv.shutdown()
            srv.server_close()


    def test_20_push_cold_client_agent_id_resolution(self):
        """C1532: cold-cache push() resolves agent_id with the effective token.

        A fresh client with no task_to_agent mapping and no cached token can
        still push with only task_id= + token=: the effective bearer is
        resolved BEFORE the get_task() agent_id lookup and forwarded to it, so
        the read is authenticated (200) and the push is accepted riding the
        same bearer. admin_token= works the same way. With no token anywhere
        the agent_id lookup fails closed with the guiding ValueError (401
        underneath) instead of an unauthenticated read.
        """
        saved_admin = os.environ.get("ADMIN_TOKEN")
        os.environ.pop("ADMIN_TOKEN", None)
        srv, _t, url, state = start_mock_l1_server(
            host="127.0.0.1",
            port=0,
            expected_admin_token="adm-cold-token",
            expected_runner_token="run-cold-token",
        )
        try:
            owner = AgentBranchesClient(server_url=url)
            task = owner.create_task(
                repo="https://github.com/cf/repo.git",
                base_sha="0000000000000000000000000000000000000000",
                intent="Cold push",
                branch="feat/cold-push",
                agent="cold-alpha",
                admin_token="adm-cold-token",
            )
            task_id = task["taskId"]
            plaintext = task["token"]["plaintext"]

            # 1. Cold client, explicit token=, NO agent_id: the bearer is
            #    forwarded to the get_task() lookup, which returns 200 and
            #    yields agentId; the push itself rides the same bearer.
            cold = AgentBranchesClient(server_url=url)
            self.assertNotIn(task_id, cold.task_to_agent)
            res = cold.push(
                task_id=task_id,
                head_sha="1111111111111111111111111111111111111111",
                token=plaintext,
            )
            self.assertTrue(res["accepted"])
            self.assertEqual(state.last_authorization, f"Bearer {plaintext}")

            # 2. Cold client, admin_token= only: admin authenticates both the
            #    agent_id lookup and the mutating push (decideMutatingAuth).
            cold_admin = AgentBranchesClient(server_url=url)
            res = cold_admin.push(
                task_id=task_id,
                head_sha="2222222222222222222222222222222222222222",
                admin_token="adm-cold-token",
            )
            self.assertTrue(res["accepted"])
            self.assertEqual(state.last_authorization, "Bearer adm-cold-token")

            # 3. NEGATIVE regression: cold client, no token anywhere -> the
            #    unauthenticated agent_id lookup is 401 and push() raises the
            #    guiding ValueError instead of sending headerless.
            cold_bare = AgentBranchesClient(server_url=url)
            with self.assertRaises(ValueError) as ctx:
                cold_bare.push(
                    task_id=task_id,
                    head_sha="3333333333333333333333333333333333333333",
                )
            self.assertIn("Cannot resolve agentId", str(ctx.exception))
        finally:
            if saved_admin is None:
                os.environ.pop("ADMIN_TOKEN", None)
            else:
                os.environ["ADMIN_TOKEN"] = saved_admin
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()


