"""Unit tests for agent_branches.bus module."""

from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import tempfile
import unittest

from agent_branches.bus import (
    AgentBusIntegrationError,
    await_task_ack,
    enroll_worker_startup,
    read_unread_messages,
    send_task_result,
)
from coordination.worker_bus import SessionlessWorkerBus


class TestAgentBranchesBus(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.bus_store = self.root / "bus"
        self.cred_file = self.root / "worker.cred.json"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_enroll_worker_startup_creates_0600_credentials(self):
        info = enroll_worker_startup(
            bus_store=self.bus_store,
            task_id="t-unit-01",
            cred_path=self.cred_file,
            agent_name="unit-worker",
        )
        self.assertEqual(info["status"], "enrolled_new")
        self.assertTrue(self.cred_file.exists())
        mode = oct(stat.S_IMODE(self.cred_file.stat().st_mode))
        self.assertEqual(mode, "0o600")

        # Confirm sessionless format: session_id is None, rendered as '-'
        self.assertIn("/-/", info["namespaced_id"])
        self.assertTrue(info["namespaced_id"].endswith("/t-unit-01"))

        # Calling again loads existing credentials
        info2 = enroll_worker_startup(
            bus_store=self.bus_store,
            task_id="t-unit-01",
            cred_path=self.cred_file,
            agent_name="unit-worker",
        )
        self.assertEqual(info2["status"], "loaded_existing")
        self.assertEqual(info2["identity_id"], info["identity_id"])

    def test_send_task_result_and_read_unread(self):
        # 1. Setup coordinator
        coord = SessionlessWorkerBus.register(
            store=self.bus_store,
            agent_name="coordinator",
            device_id="hetzner-rmthz",
            project_id="agent-branches",
            task_id="control",
        )
        coord_id = coord.identity_id

        # 2. Setup worker
        enroll_worker_startup(
            bus_store=self.bus_store,
            task_id="t-unit-02",
            cred_path=self.cred_file,
        )

        # 3. Send task_result
        payload = {"status": "passed", "commit": "1234567"}
        send_res = send_task_result(
            bus_store=self.bus_store,
            cred_path=self.cred_file,
            recipient_id=coord_id,
            payload=payload,
            kind="task_result",
        )
        self.assertEqual(send_res["status"], "sent")
        msg_id = send_res["message_id"]

        # 4. Coordinator receives message
        unread = coord.receive(unread_only=True)
        self.assertEqual(len(unread), 1)
        self.assertEqual(unread[0].message_id, msg_id)

        # 5. Coordinator ACKs and replies
        coord.ack(msg_id)
        coord.send(
            recipient_id=send_res["sender_identity_id"],
            body=json.dumps({"ack_for": msg_id, "coordinator_verdict": "ACCEPTED"}),
            kind="task_ack",
        )

        # 6. Worker awaits task ack
        ack_res = await_task_ack(
            bus_store=self.bus_store,
            cred_path=self.cred_file,
            expected_ack_for=msg_id,
            timeout_sec=5.0,
        )
        self.assertEqual(ack_res["status"], "ack_received")
        self.assertEqual(ack_res["coordinator_verdict"], "ACCEPTED")

        # 7. Worker confirms zero unread left
        read_res = read_unread_messages(self.bus_store, self.cred_file)
        self.assertEqual(read_res["unread_count"], 0)

    def test_send_task_result_missing_credentials_raises(self):
        non_existent = self.root / "missing.cred.json"
        with self.assertRaises(AgentBusIntegrationError):
            send_task_result(
                bus_store=self.bus_store,
                cred_path=non_existent,
                recipient_id="fake-coord",
                payload={"test": 1},
            )

    def test_await_task_ack_timeout_raises(self):
        enroll_worker_startup(
            bus_store=self.bus_store,
            task_id="t-unit-timeout",
            cred_path=self.cred_file,
        )
        with self.assertRaises(TimeoutError):
            await_task_ack(
                bus_store=self.bus_store,
                cred_path=self.cred_file,
                expected_ack_for="non-existent-msg-id",
                timeout_sec=0.5,
                poll_interval=0.1,
            )


if __name__ == "__main__":
    unittest.main()
