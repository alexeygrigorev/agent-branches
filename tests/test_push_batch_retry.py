"""Tests for Agent Branches push_batch retry policy, idempotence, and robust error handling.

Verifies:
- Pre-validation of input batch (types, non-empty, hex SHA-1, task/agent routing).
- Pre-validation blind spot prevention (zero partial mutation when routing cannot resolve).
- Happy-path sequential execution with head advancement and metadata persistence.
- Transient HTTP 500 / 503 recovery with exponential backoff.
- Transient HTTP 429 rate-limiting recovery.
- Transient retry exhaustion raising BatchExecutionError with structured receipts.
- Fail-immediate behavior on non-transient errors (HTTP 401, 403, 404).
- Partial success preservation (completed events retained, unattempted events isolated).
- BatchExecutionError structured properties and string representation.
- MCP alias branches_push_batch compatibility.
"""

import http.server
import json
import socketserver
import threading
import time
import unittest
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

from agent_branches import (
    AgentBranchesAPIError,
    AgentBranchesClient,
    AgentBranchesConnectionError,
    AgentBranchesError,
    BatchExecutionError,
)
from tests.mock_l1_server import (
    MockCoordinatorState,
    MockL1Handler,
    MockL1Server,
    start_mock_l1_server,
)


def _start_custom_server(
    handler_cls, state: Optional[MockCoordinatorState] = None
) -> Tuple[http.server.HTTPServer, str, MockCoordinatorState]:
    """Helper to start an ephemeral MockL1Server with a custom handler."""
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


class TestPushBatchRobustRetry(unittest.TestCase):
    """Test suite verifying push_batch robustness and remediation of REV-SDK-PUSH-BATCH flaws."""

    def setUp(self):
        self.server, self.thread, self.server_url, self.state = start_mock_l1_server(
            host="127.0.0.1", port=0
        )
        self.client = AgentBranchesClient(server_url=self.server_url, timeout=2.0)
        # Register a valid baseline task for testing
        self.task = self.client.create_task(
            repo="https://github.com/agent-branches/repo.git",
            base_sha="0000000000000000000000000000000000000000",
            intent="Base task for push_batch testing",
            branch="main",
            agent="worker-batch",
        )
        self.task_id = self.task["taskId"]
        self.agent_id = self.task["agentId"]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_01_pre_validation_input_rejections(self):
        """Test 1: Pre-validation input rejections before any network activity."""
        # Non-list events
        for bad_events in ("not-a-list", 123, None, {"event": 1}):
            with self.assertRaises(TypeError, msg=f"Should reject {type(bad_events)}"):
                self.client.push_batch(bad_events)

        # Empty list
        with self.assertRaises(ValueError) as ctx:
            self.client.push_batch([])
        self.assertIn("cannot be empty", str(ctx.exception))

        # Non-dict event element
        with self.assertRaises(TypeError) as ctx:
            self.client.push_batch(["not-a-dict"])
        self.assertIn("must be a dictionary", str(ctx.exception))

        # Missing head_sha
        with self.assertRaises(ValueError) as ctx:
            self.client.push_batch([{"task_id": self.task_id}])
        self.assertIn("missing required head_sha", str(ctx.exception))

        # Non-string head_sha
        with self.assertRaises(ValueError) as ctx:
            self.client.push_batch([{"task_id": self.task_id, "head_sha": 12345}])
        self.assertIn("missing required head_sha", str(ctx.exception))

        # Malformed hex SHA: wrong length
        with self.assertRaises(ValueError) as ctx:
            self.client.push_batch([{"task_id": self.task_id, "head_sha": "abc123"}])
        self.assertIn("must be 40-character hex SHA", str(ctx.exception))

        # Malformed hex SHA: non-hex characters
        with self.assertRaises(ValueError) as ctx:
            self.client.push_batch([{"task_id": self.task_id, "head_sha": "g" * 40}])
        self.assertIn("must be 40-character hex SHA", str(ctx.exception))

        # Missing both task_id and agent_id
        with self.assertRaises(ValueError) as ctx:
            self.client.push_batch([{"head_sha": "a" * 40}])
        self.assertIn("missing required task_id or agent_id", str(ctx.exception))

        # Negative max_retries
        valid_event = {"task_id": self.task_id, "head_sha": "a" * 40}
        with self.assertRaises(ValueError) as ctx:
            self.client.push_batch([valid_event], max_retries=-1)
        self.assertIn("max_retries", str(ctx.exception))

        # Negative retry_backoff
        with self.assertRaises(ValueError) as ctx:
            self.client.push_batch([valid_event], retry_backoff=-0.1)
        self.assertIn("retry_backoff", str(ctx.exception))

    def test_02_pre_validation_blind_spot_prevention(self):
        """Test 2: Pre-validation blind spot prevention.

        Event 0 is fully valid, Event 1 has an unresolvable task.
        Verifies ValueError is raised upfront and Event 0 was NEVER sent to
        the coordinator (zero partial mutation).
        """
        initial_task = self.client.get_task(self.task_id)
        self.assertEqual(initial_task.get("pushes", 0), 0)
        self.assertEqual(initial_task.get("head_sha"), "0" * 40)

        events = [
            {
                "task_id": self.task_id,
                "head_sha": "1" * 40,
                "intent": "Event 0 valid intent",
            },
            {
                "task_id": "non-existent-task-9999",
                "head_sha": "2" * 40,
                "intent": "Event 1 unresolvable intent",
            },
        ]

        # Call push_batch; should fail upfront during pre-resolution of event 1
        with self.assertRaises(ValueError) as ctx:
            self.client.push_batch(events)
        self.assertIn("Cannot resolve agentId for task 'non-existent-task-9999'", str(ctx.exception))

        # Inspect coordinator state: Event 0 was NEVER committed
        task_after = self.client.get_task(self.task_id)
        self.assertEqual(
            task_after.get("pushes", 0),
            0,
            "Coordinator state was mutated despite pre-validation failure!",
        )
        self.assertEqual(
            task_after.get("head_sha"),
            "0" * 40,
            "Coordinator head SHA was modified by unvalidated batch!",
        )
        self.assertNotEqual(
            task_after.get("intent"),
            "Event 0 valid intent",
            "Intent was mutated by unvalidated batch!",
        )

    def test_03_happy_path_batch_execution(self):
        """Test 3: Happy-path batch execution.

        Submits 3 events in sequence with different SHAs, intents, and test_provenance.
        Verifies list of 3 results returned, all accepted=True, coordinator heads updated.
        """
        sha1 = "1111111111111111111111111111111111111111"
        sha2 = "2222222222222222222222222222222222222222"
        sha3 = "3333333333333333333333333333333333333333"

        events = [
            {
                "task_id": self.task_id,
                "head_sha": sha1,
                "intent": "Step 1: scaffold",
                "test_provenance": "pytest: 10 passed",
            },
            {
                "task_id": self.task_id,
                "head_sha": sha2,
                "intent": "Step 2: implement",
                "test_provenance": "pytest: 25 passed",
            },
            {
                "task_id": self.task_id,
                "head_sha": sha3,
                "intent": "Step 3: polish",
                "test_provenance": "pytest: 46 passed",
            },
        ]

        results = self.client.push_batch(events)
        self.assertEqual(len(results), 3)
        for idx, res in enumerate(results):
            self.assertTrue(res.get("accepted"), f"Event {idx} was not accepted")

        # Verify coordinator state advanced to final event
        task_rec = self.client.get_task(self.task_id)
        self.assertEqual(task_rec["head_sha"], sha3)
        self.assertEqual(task_rec["pushes"], 3)
        self.assertEqual(task_rec["intent"], "Step 3: polish")
        self.assertEqual(task_rec["test_provenance"], "pytest: 46 passed")

    def test_04_transient_503_error_with_recovery(self):
        """Test 4: Transient HTTP 503 error with recovery.

        Handler fails first 2 attempts with 503, succeeds on 3rd attempt.
        Verify batch completes with backoff.
        """
        attempts = 0
        attempts_lock = threading.Lock()

        class Transient503Handler(MockL1Handler):
            def do_POST(self):
                nonlocal attempts
                path = urllib.parse.urlparse(self.path).path
                if path == "/events/push":
                    with attempts_lock:
                        attempts += 1
                        current_attempt = attempts
                    if current_attempt <= 2:
                        self._send_json(
                            503,
                            {
                                "error": "service_unavailable",
                                "message": f"Transient failure attempt {current_attempt}",
                            },
                        )
                        return
                super().do_POST()

        server, url, state = _start_custom_server(Transient503Handler)
        try:
            client = AgentBranchesClient(server_url=url, timeout=2.0)
            task = client.create_task(
                repo="https://github.com/repo.git",
                base_sha="0" * 40,
                intent="Testing transient 503",
                branch="main",
                agent="flaky-worker",
            )
            sha = "4" * 40
            event = {
                "task_id": task["taskId"],
                "head_sha": sha,
                "intent": "Transient recovery intent",
            }

            start_t = time.time()
            results = client.push_batch([event], max_retries=3, retry_backoff=0.02)
            elapsed = time.time() - start_t

            self.assertEqual(len(results), 1)
            self.assertTrue(results[0].get("accepted"))
            self.assertEqual(attempts, 3, "Expected exactly 3 attempts (2 failures + 1 success)")
            # Backoff was: 0.02 * 2^0 (0.02) + 0.02 * 2^1 (0.04) = 0.06s minimum
            self.assertGreaterEqual(elapsed, 0.05, "Exponential backoff sleep was not applied")
        finally:
            server.shutdown()
            server.server_close()

    def test_05_transient_429_rate_limit_with_recovery(self):
        """Test 5: Transient HTTP 429 Rate Limiting with recovery.

        Handler returns 429 on first attempt, then 200.
        Verify 429 is classified as transient and batch completes.
        """
        attempts = 0
        attempts_lock = threading.Lock()

        class Transient429Handler(MockL1Handler):
            def do_POST(self):
                nonlocal attempts
                path = urllib.parse.urlparse(self.path).path
                if path == "/events/push":
                    with attempts_lock:
                        attempts += 1
                        current_attempt = attempts
                    if current_attempt == 1:
                        self._send_json(
                            429,
                            {
                                "error": "rate_limited",
                                "message": "Too many requests, slow down",
                            },
                        )
                        return
                super().do_POST()

        server, url, state = _start_custom_server(Transient429Handler)
        try:
            client = AgentBranchesClient(server_url=url, timeout=2.0)
            task = client.create_task(
                repo="https://github.com/repo.git",
                base_sha="0" * 40,
                intent="Testing transient 429",
                branch="main",
                agent="rate-limited-worker",
            )
            sha = "5" * 40
            event = {"task_id": task["taskId"], "head_sha": sha, "intent": "Rate limit test"}

            results = client.push_batch([event], max_retries=3, retry_backoff=0.01)
            self.assertEqual(len(results), 1)
            self.assertTrue(results[0].get("accepted"))
            self.assertEqual(attempts, 2, "Expected 2 attempts (1 rate-limit + 1 retry success)")
        finally:
            server.shutdown()
            server.server_close()

    def test_06_transient_retry_exhaustion(self):
        """Test 6: Transient retry exhaustion.

        Handler persistently returns 503.
        Verify BatchExecutionError is raised with failed_index == 0,
        succeeded == [], and subsequent events in unattempted_events.
        """
        attempts = 0
        attempts_lock = threading.Lock()

        class Persistent503Handler(MockL1Handler):
            def do_POST(self):
                nonlocal attempts
                path = urllib.parse.urlparse(self.path).path
                if path == "/events/push":
                    with attempts_lock:
                        attempts += 1
                    self._send_json(
                        503,
                        {"error": "service_unavailable", "message": "Persistent backend outage"},
                    )
                    return
                super().do_POST()

        server, url, state = _start_custom_server(Persistent503Handler)
        try:
            client = AgentBranchesClient(server_url=url, timeout=2.0)
            task = client.create_task(
                repo="https://github.com/repo.git",
                base_sha="0" * 40,
                intent="Testing retry exhaustion",
                branch="main",
                agent="exhausted-worker",
            )
            event0 = {"task_id": task["taskId"], "head_sha": "6" * 40}
            event1 = {"task_id": task["taskId"], "head_sha": "7" * 40}

            max_retries = 3
            with self.assertRaises(BatchExecutionError) as ctx:
                client.push_batch([event0, event1], max_retries=max_retries, retry_backoff=0.01)

            err = ctx.exception
            self.assertEqual(err.failed_index, 0)
            self.assertEqual(err.succeeded, [])
            self.assertEqual(err.completed, [])
            self.assertEqual(len(err.unattempted_events), 1)
            self.assertEqual(err.unattempted_events[0], event1)
            self.assertEqual(err.status_code, 503)
            self.assertIsInstance(err.original_error, AgentBranchesAPIError)
            self.assertEqual(attempts, 1 + max_retries, "Must attempt 1 initial + max_retries")
        finally:
            server.shutdown()
            server.server_close()

    def test_07_non_transient_error_fails_immediately(self):
        """Test 7: Non-transient errors (HTTP 401, 403, 404).

        Handler returns 401 Unauthorized.
        Verify fails IMMEDIATELY on attempt 0 without retrying, raising BatchExecutionError.
        """
        attempts = 0
        attempts_lock = threading.Lock()

        class NonTransient401Handler(MockL1Handler):
            def do_POST(self):
                nonlocal attempts
                path = urllib.parse.urlparse(self.path).path
                if path == "/events/push":
                    with attempts_lock:
                        attempts += 1
                    self._send_json(
                        401,
                        {"error": "unauthorized", "message": "Bearer credentials invalid"},
                    )
                    return
                super().do_POST()

        server, url, state = _start_custom_server(NonTransient401Handler)
        try:
            client = AgentBranchesClient(server_url=url, timeout=2.0)
            task = client.create_task(
                repo="https://github.com/repo.git",
                base_sha="0" * 40,
                intent="Testing non-transient 401",
                branch="main",
                agent="auth-fail-worker",
            )
            event0 = {"task_id": task["taskId"], "head_sha": "8" * 40}
            event1 = {"task_id": task["taskId"], "head_sha": "9" * 40}

            with self.assertRaises(BatchExecutionError) as ctx:
                client.push_batch([event0, event1], max_retries=3, retry_backoff=0.05)

            err = ctx.exception
            self.assertEqual(err.failed_index, 0)
            self.assertEqual(err.succeeded, [])
            self.assertEqual(len(err.unattempted_events), 1)
            self.assertEqual(err.unattempted_events[0], event1)
            self.assertEqual(err.status_code, 401)
            self.assertEqual(attempts, 1, "Non-transient 401 must fail immediately with 0 retries")
        finally:
            server.shutdown()
            server.server_close()

    def test_08_partial_success_preservation(self):
        """Test 8: Partial success preservation.

        Event 0 succeeds, Event 1 fails (persistent 500).
        Verify BatchExecutionError has len(err.succeeded) == 1, err.failed_index == 1,
        err.unattempted_events contains Event 2, and Event 0 is NOT re-sent.
        """
        sha0 = "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0"
        sha1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
        sha2 = "a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2"

        push_calls: List[str] = []
        lock = threading.Lock()

        class FailOnSecondEventHandler(MockL1Handler):
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
                            {"error": "internal_error", "message": "Crash on commit 1"},
                        )
                        return
                    # For sha0, record push in state
                    res = self.state.record_push(body)
                    self._send_json(200, res)
                    return
                super().do_POST()

        server, url, state = _start_custom_server(FailOnSecondEventHandler)
        try:
            client = AgentBranchesClient(server_url=url, timeout=2.0)
            task = client.create_task(
                repo="https://github.com/repo.git",
                base_sha="0" * 40,
                intent="Testing partial success",
                branch="main",
                agent="partial-worker",
            )
            events = [
                {"task_id": task["taskId"], "head_sha": sha0, "intent": "Step 0"},
                {"task_id": task["taskId"], "head_sha": sha1, "intent": "Step 1"},
                {"task_id": task["taskId"], "head_sha": sha2, "intent": "Step 2"},
            ]

            max_retries = 2
            with self.assertRaises(BatchExecutionError) as ctx:
                client.push_batch(events, max_retries=max_retries, retry_backoff=0.01)

            err = ctx.exception
            # Verify structured receipts
            self.assertEqual(len(err.succeeded), 1)
            self.assertEqual(len(err.completed), 1)
            self.assertTrue(err.succeeded[0].get("accepted"))
            self.assertEqual(err.failed_index, 1)
            self.assertEqual(len(err.unattempted_events), 1)
            self.assertEqual(err.unattempted_events[0], events[2])
            self.assertEqual(err.status_code, 500)

            # Verify push call history:
            # sha0 was called ONCE.
            # sha1 was called (1 initial + 2 retries) = 3 times.
            # sha2 was NEVER called.
            with lock:
                self.assertEqual(push_calls.count(sha0), 1, "Event 0 must not be re-sent during retries")
                self.assertEqual(push_calls.count(sha1), 1 + max_retries)
                self.assertEqual(push_calls.count(sha2), 0, "Event 2 must remain unattempted")

            # Verify coordinator state preserved Event 0
            task_rec = client.get_task(task["taskId"])
            self.assertEqual(task_rec["head_sha"], sha0)
            self.assertEqual(task_rec["pushes"], 1)
        finally:
            server.shutdown()
            server.server_close()

    def test_09_batch_execution_error_properties_and_str(self):
        """Test 9: BatchExecutionError properties and string representation."""
        # 1. With an API error cause
        api_err = AgentBranchesAPIError(503, "Service Unavailable", {"code": "OVERLOAD"})
        succeeded_list = [{"accepted": True, "head": "a" * 40}]
        unattempted_list = [{"head_sha": "c" * 40}]

        batch_err = BatchExecutionError(
            message="Batch execution failed at index 1",
            succeeded=succeeded_list,
            failed_index=1,
            original_error=api_err,
            unattempted_events=unattempted_list,
        )

        self.assertIsInstance(batch_err, AgentBranchesAPIError)
        self.assertIsInstance(batch_err, AgentBranchesError)
        self.assertEqual(batch_err.status_code, 503)
        self.assertEqual(batch_err.payload, {"code": "OVERLOAD"})
        self.assertEqual(batch_err.failed_index, 1)
        self.assertEqual(batch_err.succeeded, succeeded_list)
        self.assertEqual(batch_err.completed, succeeded_list)
        self.assertEqual(batch_err.unattempted_events, unattempted_list)
        self.assertIs(batch_err.original_error, api_err)

        err_str = str(batch_err)
        self.assertIn("failed_at_index=1", err_str)
        self.assertIn("succeeded=1", err_str)
        self.assertIn("unattempted=1", err_str)
        self.assertIn("cause=", err_str)

        # 2. With a ConnectionError cause (no status_code attribute)
        conn_err = AgentBranchesConnectionError("Connection refused to coordinator")
        batch_err2 = BatchExecutionError(
            message="Batch failed",
            succeeded=[],
            failed_index=0,
            original_error=conn_err,
            unattempted_events=[{"head_sha": "1" * 40}],
        )
        self.assertEqual(batch_err2.status_code, 0)
        self.assertIsNone(batch_err2.payload)
        self.assertEqual(batch_err2.failed_index, 0)
        self.assertEqual(batch_err2.succeeded, [])
        self.assertEqual(len(batch_err2.unattempted_events), 1)

    def test_10_mcp_alias_branches_push_batch(self):
        """Test 10: MCP alias branches_push_batch."""
        sha = "f" * 40
        events = [{"task_id": self.task_id, "head_sha": sha, "intent": "MCP batch push"}]
        results = self.client.branches_push_batch(events)
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0].get("accepted"))

        task_rec = self.client.get_task(self.task_id)
        self.assertEqual(task_rec["head_sha"], sha)
        self.assertEqual(task_rec["intent"], "MCP batch push")


if __name__ == "__main__":
    unittest.main()
