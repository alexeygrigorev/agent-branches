"""Unit tests for Sessionless Branches Sync AgentBus Callback Pipeline (C2786 / C3021 / C3022)."""

import json
import os
from pathlib import Path
import tempfile
import unittest

from scripts.run_branches_sessionless_sync import (
    cmd_head_consume,
    cmd_head_init,
    cmd_worker_exec,
    file_sha256,
)


class TestSessionlessSyncBus(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="test-sessionless-sync-")
        self.base_dir = Path(self.temp_dir.name)
        self.bus_dir = self.base_dir / "bus"
        self.ws_dir = self.base_dir / "workspace"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_sessionless_sync_pipeline_end_to_end(self):
        # 1. Head Init
        init_res = cmd_head_init(self.bus_dir, self.ws_dir)
        self.assertEqual(init_res["status"], "INIT_SUCCESS")
        self.assertEqual(init_res["task_id"], "t-branches-sync-sessionless-bus")

        head_cred_file = self.bus_dir / "head.cred.json"
        worker_cred_file = self.bus_dir / "worker.cred.json"
        self.assertTrue(head_cred_file.exists())
        self.assertTrue(worker_cred_file.exists())

        # Verify 0600 permissions
        self.assertEqual(oct(head_cred_file.stat().st_mode & 0o777), "0o600")
        self.assertEqual(oct(worker_cred_file.stat().st_mode & 0o777), "0o600")

        # 2. Worker Exec
        worker_res = cmd_worker_exec(self.bus_dir, self.ws_dir)
        self.assertEqual(worker_res["status"], "WORKER_SUCCESS")
        self.assertTrue(worker_res["pipeline_success"])

        art_path = Path(worker_res["artifact_path"])
        self.assertTrue(art_path.exists())
        expected_digest = file_sha256(art_path)
        self.assertEqual(worker_res["artifact_digest"], expected_digest)

        # 3. Head Consume
        head_res = cmd_head_consume(self.bus_dir, self.ws_dir)
        self.assertEqual(head_res["status"], "HEAD_CONSUMED")
        self.assertTrue(head_res["is_valid"])
        self.assertTrue(head_res["pipeline_success"])
        self.assertEqual(head_res["stages"]["preview"], "PASSED")
        self.assertEqual(head_res["stages"]["isolated_push"], "PASSED")
        self.assertEqual(head_res["stages"]["remote_recovery"], "PASSED")

    def test_sessionless_sync_tamper_fails_closed(self):
        cmd_head_init(self.bus_dir, self.ws_dir)
        worker_res = cmd_worker_exec(self.bus_dir, self.ws_dir)
        art_path = Path(worker_res["artifact_path"])

        # Tamper with the artifact file
        payload = json.loads(art_path.read_text(encoding="utf-8"))
        payload["tampered"] = True
        art_path.write_text(json.dumps(payload), encoding="utf-8")

        # Head consume must fail closed
        with self.assertRaises(ValueError) as ctx:
            cmd_head_consume(self.bus_dir, self.ws_dir)
        self.assertIn("Digest mismatch", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
