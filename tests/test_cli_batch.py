"""Tests for Agent Branches CLI push-batch subcommand and Two Generals batch receipts.

Verifies:
1. Happy-path push-batch via CLI runner -> exit code 0, outputs accepted events.
   - Tested with --events-file (JSON array file).
   - Tested with repeatable --event flags.
   - Tested with --json flag.
2. Input validation error -> exit code 2 / error, zero network pushes.
   - Tested with invalid SHA format/length.
   - Tested with missing task_id and agent_id.
   - Tested with empty events list.
   - Tested with missing arguments.
   - Asserts zero mutating pushes hit the coordinator.
3. Partial failure with BatchExecutionError -> exit code 1, structured receipt output:
   - Identifies failed index.
   - Identifies underlying cause.
   - Displays ambiguous event (mutation status unconfirmed).
   - Lists succeeded events (clearly demarcated as committed, never replayed).
   - Lists unattempted events.
4. Two Generals commit-then-timeout / ambiguous mutation -> exit code 1:
   - Server commits then abruptly drops connection.
   - Displays ambiguous_event.
   - Asserts zero duplicate pushes (push count == 1, fail-closed).
"""

import http.server
import json
import os
import socketserver
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

from agent_branches import (
    AgentBranchesClient,
    AgentBranchesConnectionError,
    BatchExecutionError,
)
from agent_branches.cli import cmd_push_batch, format_batch_error_receipt, main
from tests.mock_l1_server import (
    MockCoordinatorState,
    MockL1Handler,
    start_mock_l1_server,
)


def _start_custom_server(
    handler_cls, state: Optional[MockCoordinatorState] = None
) -> Tuple[http.server.HTTPServer, str, MockCoordinatorState]:
    """Helper to start an ephemeral server with a custom handler."""
    server_state = state or MockCoordinatorState()

    class CustomServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True
        allow_reuse_address = True

        def __init__(self, addr):
            super().__init__(addr, handler_cls)
            self.state = server_state

    server = CustomServer(("127.0.0.1", 0))
    port = server.server_address[1]
    url = f"http://127.0.0.1:{port}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, url, server_state


class TestCLIBatchReceipts(unittest.TestCase):
    """End-to-end tests for agent-branches push-batch CLI subcommand."""

    @classmethod
    def setUpClass(cls):
        cls.repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        cls.cli_path = os.path.join(cls.repo_root, "agent-branches")

    def run_cli(
        self,
        args: List[str],
        env_vars: Optional[Dict[str, str]] = None,
        check: bool = True,
        input_data: Optional[str] = None,
    ) -> subprocess.CompletedProcess:
        """Helper to invoke agent-branches CLI via subprocess."""
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

    def test_01_happy_path_push_batch_cli(self):
        """Test 1: Happy-path push-batch via CLI runner -> exit code 0, outputs accepted events."""
        server, thread, server_url, state = start_mock_l1_server(host="127.0.0.1", port=0)
        try:
            client = AgentBranchesClient(server_url=server_url, timeout=2.0)
            task = client.create_task(
                repo="https://github.com/agent-branches/repo.git",
                base_sha="0000000000000000000000000000000000000000",
                intent="Testing CLI push-batch happy path",
                branch="main",
                agent="cli-worker",
            )
            task_id = task["taskId"]

            sha1 = "1111111111111111111111111111111111111111"
            sha2 = "2222222222222222222222222222222222222222"
            sha3 = "3333333333333333333333333333333333333333"

            # 1a. Test via --events-file
            events = [
                {"task_id": task_id, "head_sha": sha1, "intent": "Step 1: setup"},
                {"task_id": task_id, "head_sha": sha2, "intent": "Step 2: feature"},
            ]

            tmp_dir = os.environ.get("TMPDIR")
            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".json", delete=False, dir=tmp_dir, encoding="utf-8"
            ) as tf:
                json.dump(events, tf)
                events_file_path = tf.name

            try:
                res_file = self.run_cli(
                    [
                        "push-batch",
                        "--events-file",
                        events_file_path,
                        "--server",
                        server_url,
                    ],
                    check=True,
                )
                self.assertEqual(res_file.returncode, 0)
                accepted_events = json.loads(res_file.stdout)
                self.assertIsInstance(accepted_events, list)
                self.assertEqual(len(accepted_events), 2)
                self.assertTrue(accepted_events[0]["accepted"])
                self.assertTrue(accepted_events[1]["accepted"])
                self.assertEqual(accepted_events[0]["head_sha"], sha1)
                self.assertEqual(accepted_events[1]["head_sha"], sha2)
            finally:
                if os.path.exists(events_file_path):
                    os.remove(events_file_path)

            # 1b. Test via repeatable --event flags
            ev3_str = json.dumps(
                {
                    "task_id": task_id,
                    "head_sha": sha3,
                    "intent": "Step 3: final",
                    "test_provenance": "vitest: 10 passed",
                }
            )
            res_repeat = self.run_cli(
                [
                    "push-batch",
                    "--event",
                    ev3_str,
                    "--server",
                    server_url,
                    "--json",
                ],
                check=True,
            )
            self.assertEqual(res_repeat.returncode, 0)
            accepted_repeat = json.loads(res_repeat.stdout)
            self.assertEqual(len(accepted_repeat), 1)
            self.assertTrue(accepted_repeat[0]["accepted"])
            self.assertEqual(accepted_repeat[0]["head_sha"], sha3)

            # Verify coordinator state recorded all 3 pushes
            task_rec = client.get_task(task_id)
            self.assertEqual(task_rec["head_sha"], sha3)
            self.assertEqual(task_rec["pushes"], 3)
            self.assertEqual(task_rec["intent"], "Step 3: final")
        finally:
            server.shutdown()
            server.server_close()

    def test_02_input_validation_error_zero_network_pushes(self):
        """Test 2: Input validation error -> exit code 2 / error, zero network pushes."""
        push_requests = []
        lock = threading.Lock()

        class RequestTrackingHandler(MockL1Handler):
            def do_POST(self):
                path = urllib.parse.urlparse(self.path).path
                if path == "/events/push":
                    with lock:
                        push_requests.append(self.path)
                super().do_POST()

        server, url, state = _start_custom_server(RequestTrackingHandler)
        try:
            client = AgentBranchesClient(server_url=url, timeout=2.0)
            task = client.create_task(
                repo="https://github.com/agent-branches/repo.git",
                base_sha="0" * 40,
                intent="Testing input validation",
                branch="main",
                agent="validation-worker",
            )
            task_id = task["taskId"]

            # 2a. Neither --events-file nor --event specified -> exit code 2
            res_no_args = self.run_cli(
                ["push-batch", "--server", url],
                check=False,
            )
            self.assertEqual(res_no_args.returncode, 2)
            self.assertIn("either --events-file or at least one --event", res_no_args.stderr)

            # 2b. Invalid SHA format/length -> exit code 2
            bad_sha_event = json.dumps({"task_id": task_id, "head_sha": "not-a-valid-sha"})
            res_bad_sha = self.run_cli(
                ["push-batch", "--event", bad_sha_event, "--server", url],
                check=False,
            )
            self.assertEqual(res_bad_sha.returncode, 2)
            self.assertIn("invalid head_sha", res_bad_sha.stderr)

            # 2c. Missing task_id and agent_id -> exit code 2
            no_target_event = json.dumps({"head_sha": "a" * 40})
            res_no_target = self.run_cli(
                ["push-batch", "--event", no_target_event, "--server", url],
                check=False,
            )
            self.assertEqual(res_no_target.returncode, 2)
            self.assertIn("missing required task_id or agent_id", res_no_target.stderr)

            # 2d. Empty events array in file -> exit code 2
            tmp_dir = os.environ.get("TMPDIR")
            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".json", delete=False, dir=tmp_dir, encoding="utf-8"
            ) as tf:
                json.dump([], tf)
                empty_file_path = tf.name

            try:
                res_empty = self.run_cli(
                    ["push-batch", "--events-file", empty_file_path, "--server", url],
                    check=False,
                )
                self.assertEqual(res_empty.returncode, 2)
                self.assertIn("events list cannot be empty", res_empty.stderr)
            finally:
                if os.path.exists(empty_file_path):
                    os.remove(empty_file_path)

            # Invariant: ZERO network push requests were dispatched across all invalid inputs!
            with lock:
                self.assertEqual(
                    len(push_requests),
                    0,
                    "Input validation errors must fail closed with zero network pushes!",
                )
        finally:
            server.shutdown()
            server.server_close()

    def test_03_partial_failure_with_batch_execution_error_receipt(self):
        """Test 3: Partial failure with BatchExecutionError -> exit code 1, structured receipt."""
        sha0 = "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0"
        sha1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
        sha2 = "a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2"

        push_calls: List[str] = []
        lock = threading.Lock()

        class FailSecondEventHandler(MockL1Handler):
            def do_POST(self):
                path = urllib.parse.urlparse(self.path).path
                if path == "/events/push":
                    try:
                        body = self._read_json()
                    except Exception as e:
                        self._send_json(400, {"error": str(e)})
                        return
                    sha = body.get("head_sha") or body.get("sha")
                    with lock:
                        push_calls.append(sha)
                    if sha == sha1:
                        self._send_json(
                            500,
                            {"error": "internal_error", "message": "Simulated coordinator crash"},
                        )
                        return
                    res = self.state.record_push(body)
                    self._send_json(200, res)
                    return
                super().do_POST()

        server, url, state = _start_custom_server(FailSecondEventHandler)
        try:
            client = AgentBranchesClient(server_url=url, timeout=2.0)
            task = client.create_task(
                repo="https://github.com/agent-branches/repo.git",
                base_sha="0" * 40,
                intent="Testing partial failure receipt",
                branch="main",
                agent="partial-worker",
            )
            task_id = task["taskId"]

            events = [
                {"task_id": task_id, "head_sha": sha0, "intent": "Step 0: success"},
                {"task_id": task_id, "head_sha": sha1, "intent": "Step 1: fails 500"},
                {"task_id": task_id, "head_sha": sha2, "intent": "Step 2: unattempted"},
            ]

            tmp_dir = os.environ.get("TMPDIR")
            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".json", delete=False, dir=tmp_dir, encoding="utf-8"
            ) as tf:
                json.dump(events, tf)
                batch_file = tf.name

            try:
                # 3a. Standard CLI invocation (prints structured failure receipt to stderr)
                res = self.run_cli(
                    ["push-batch", "--events-file", batch_file, "--server", url],
                    check=False,
                )
                self.assertEqual(res.returncode, 1)

                output = res.stderr
                # Verify exact receipt elements
                self.assertIn("Error: Batch push failed at event index 1", output)
                self.assertIn("Underlying cause:", output)
                self.assertIn("500", output)
                self.assertIn("Ambiguous event (mutation status unconfirmed):", output)
                self.assertIn(sha1, output)
                self.assertIn("Succeeded events (1):", output)
                self.assertIn(sha0, output)
                self.assertIn("Unattempted events (1):", output)
                self.assertIn(
                    "Guarantee: Succeeded events are clearly demarcated as committed and NEVER replayed.",
                    output,
                )

                # Verify dispatch counts for 3a:
                with lock:
                    self.assertEqual(push_calls.count(sha0), 1, "Event 0 must not be re-sent")
                    self.assertEqual(push_calls.count(sha1), 1, "Event 1 must fail closed immediately")
                    self.assertEqual(push_calls.count(sha2), 0, "Event 2 must remain unattempted")
                    push_calls.clear()

                # 3b. Verify --json flag emits structured JSON failure receipt
                res_json = self.run_cli(
                    ["push-batch", "--events-file", batch_file, "--server", url, "--json"],
                    check=False,
                )
                self.assertEqual(res_json.returncode, 1)
                json_receipt = json.loads(res_json.stderr)
                self.assertEqual(json_receipt["error"], "batch_push_failed")
                self.assertEqual(json_receipt["failed_index"], 1)
                self.assertEqual(len(json_receipt["succeeded"]), 1)
                self.assertEqual(json_receipt["ambiguous_event"]["head_sha"], sha1)
                self.assertEqual(len(json_receipt["unattempted_events"]), 1)
                self.assertEqual(json_receipt["unattempted_events"][0]["head_sha"], sha2)

                # Verify dispatch counts for 3b:
                with lock:
                    self.assertEqual(push_calls.count(sha0), 1, "Event 0 must not be re-sent")
                    self.assertEqual(push_calls.count(sha1), 1, "Event 1 must fail closed immediately")
                    self.assertEqual(push_calls.count(sha2), 0, "Event 2 must remain unattempted")
            finally:
                if os.path.exists(batch_file):
                    os.remove(batch_file)

            # Assert coordinator state preserved Event 0
            task_rec = client.get_task(task_id)
            self.assertEqual(task_rec["head_sha"], sha0)
            # Exactly 1 because coordinator deduplicates the re-sent sha0 in 3b (deduped: True)
            self.assertEqual(task_rec["pushes"], 1)
        finally:
            server.shutdown()
            server.server_close()

    def test_04_commit_then_timeout_ambiguous_mutation_safety(self):
        """Test 4: Commit-then-timeout / ambiguous mutation -> exit code 1, zero duplicate pushes.

        Two Generals safety (C1662 / C1672):
        The coordinator receives POST /events/push and records the mutation, but the network
        connection drops abruptly before returning the HTTP response.
        The CLI must:
        - Fail closed with exit code 1.
        - Display ambiguous_event (mutation status unconfirmed).
        - Issue ZERO duplicate pushes (no blind retries).
        """
        push_receipts = []
        lock = threading.Lock()

        class CommitThenDropHandler(MockL1Handler):
            def do_POST(self):
                path = urllib.parse.urlparse(self.path).path
                if path == "/events/push":
                    body = self._read_json()
                    with lock:
                        push_receipts.append(body)
                    # Mutate coordinator state before dropping connection
                    self.state.record_push(body)
                    # Abruptly close socket without returning HTTP response
                    self.close_connection = True
                    try:
                        self.connection.shutdown(2)
                        self.connection.close()
                    except Exception:
                        pass
                    return
                super().do_POST()

        server, url, state = _start_custom_server(CommitThenDropHandler)
        try:
            client = AgentBranchesClient(server_url=url, timeout=2.0)
            task = client.create_task(
                repo="https://github.com/agent-branches/repo.git",
                base_sha="0" * 40,
                intent="Testing commit-then-drop ambiguous mutation",
                branch="main",
                agent="two-generals-worker",
            )
            task_id = task["taskId"]

            sha_ambiguous = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
            sha_subsequent = "ffffffffffffffffffffffffffffffffffffffff"

            ev0_str = json.dumps(
                {
                    "task_id": task_id,
                    "head_sha": sha_ambiguous,
                    "intent": "Step 0: commit then drop",
                }
            )
            ev1_str = json.dumps(
                {
                    "task_id": task_id,
                    "head_sha": sha_subsequent,
                    "intent": "Step 1: subsequent",
                }
            )

            res = self.run_cli(
                [
                    "push-batch",
                    "--event",
                    ev0_str,
                    "--event",
                    ev1_str,
                    "--server",
                    url,
                ],
                check=False,
            )

            # Must exit with code 1
            self.assertEqual(res.returncode, 1)

            # Verify structured receipt in stderr
            output = res.stderr
            self.assertIn("Error: Batch push failed at event index 0", output)
            self.assertIn("Underlying cause:", output)
            self.assertIn("Ambiguous event (mutation status unconfirmed):", output)
            self.assertIn(sha_ambiguous, output)
            self.assertIn("Succeeded events (0):", output)
            self.assertIn("Unattempted events (1):", output)
            self.assertIn(sha_subsequent, output)

            # Two Generals Invariant: Server received exactly 1 push!
            # Must NOT blindly retry or send duplicate pushes!
            with lock:
                self.assertEqual(
                    len(push_receipts),
                    1,
                    "Two Generals safety violation: issued duplicate push on ambiguous timeout!",
                )

            # The coordinator state recorded the commit
            task_rec = state.tasks.get(task_id)
            self.assertIsNotNone(task_rec)
            self.assertEqual(task_rec["head_sha"], sha_ambiguous)
            self.assertEqual(task_rec["pushes"], 1)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
