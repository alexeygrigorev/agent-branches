#!/usr/bin/env python3
"""Offline test suite for L3 Advisory Radar Engine.

Verifies:
1. Disjoint commits without tests -> returns status='not_checked' (never 'clean').
2. Clean textual merge with positive tests (> 0 collected) -> returns status='clean'.
3. Overlapping conflicting commits on same line -> returns status='conflict' with kind='textual'.
4. Clean textual merge but broken semantic contract -> returns status='conflict' with kind='test'.
5. Missing commit object -> returns status='unknown'.
6. 0 collected tests -> returns status='unknown' (reason='no_tests_collected').
7. Process hang/timeout -> strictly kills process group and returns status='unknown'.
8. Safe archive extraction -> rejects directory traversal / symlink escape.
9. Deterministic bounded matrix evaluation.
"""

from __future__ import annotations

import io
import json
import os
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest

from radar.engine import (
    AgentHead,
    MatrixResult,
    PairResult,
    RadarEngine,
    STATUS_CLEAN,
    STATUS_CONFLICT,
    STATUS_NOT_CHECKED,
    STATUS_UNKNOWN,
    create_warning,
    evaluate_pair,
    export_l1_payload,
    run_matrix,
    safe_extract_tar,
)


class TestRadarEngine(unittest.TestCase):
    """Test suite for RadarEngine in-memory trial merges and test execution."""

    def _init_repo(self, path: str) -> None:
        """Initialize a local test git repository."""
        subprocess.run(["git", "init", path], check=True, capture_output=True)
        subprocess.run(["git", "-C", path, "config", "user.email", "radar@antigravity.internal"], check=True)
        subprocess.run(["git", "-C", path, "config", "user.name", "L3 Radar Builder"], check=True)
        subprocess.run(["git", "-C", path, "config", "commit.gpgsign", "false"], check=True)

    def _commit(self, repo: str, message: str) -> str:
        """Add all and commit in repo, returning commit SHA."""
        subprocess.run(["git", "-C", repo, "add", "."], check=True, capture_output=True)
        subprocess.run(["git", "-C", repo, "commit", "-m", message], check=True, capture_output=True)
        res = subprocess.run(["git", "-C", repo, "rev-parse", "HEAD"], check=True, capture_output=True, text=True)
        return res.stdout.strip()

    def test_1a_disjoint_commits_without_tests_returns_not_checked(self):
        """Test 1a: Disjoint files without tests -> returns 'not_checked' (never 'clean')."""
        with tempfile.TemporaryDirectory() as td:
            self._init_repo(td)

            # Base commit
            with open(os.path.join(td, "file_a.txt"), "w") as f:
                f.write("base A\n")
            with open(os.path.join(td, "file_b.txt"), "w") as f:
                f.write("base B\n")
            base_sha = self._commit(td, "base commit")

            # Head A: modify file_a.txt
            with open(os.path.join(td, "file_a.txt"), "w") as f:
                f.write("agent A update\n")
            head_a_sha = self._commit(td, "agent A commit")

            # Head B: checkout base, modify file_b.txt
            subprocess.run(["git", "-C", td, "checkout", "-b", "branch-b", base_sha], check=True, capture_output=True)
            with open(os.path.join(td, "file_b.txt"), "w") as f:
                f.write("agent B update\n")
            head_b_sha = self._commit(td, "agent B commit")

            engine = RadarEngine(repo_path=td)
            head_a = AgentHead(id="agent-01", sha=head_a_sha, base_sha=base_sha)
            head_b = AgentHead(id="agent-02", sha=head_b_sha, base_sha=base_sha)

            res = engine.evaluate_pair(head_a, head_b)

            # Strict assertion: Must NOT be clean! Must be 'not_checked'
            self.assertEqual(res.status, STATUS_NOT_CHECKED)
            self.assertEqual(res, "not_checked")
            self.assertTrue(res.is_not_checked)
            self.assertFalse(res.is_clean)
            self.assertFalse(res.is_conflict)
            self.assertFalse(res.is_unknown)
            self.assertIsNone(res.warning)
            self.assertIsNone(res.kind)
            self.assertEqual(res.overlapping_files, [])
            self.assertIsNotNone(res.tree_sha)

            # Verify report contract: {status, kind, evidence}
            rep = res.report()
            self.assertEqual(rep["status"], "not_checked")
            self.assertIsNone(rep["kind"])
            self.assertEqual(rep["evidence"]["reason"], "disjoint_no_tests")

    def test_1b_clean_with_positive_collected_tests(self):
        """Test 1b: Both textual merge is clean AND tests positively executed with > 0 tests -> 'clean'."""
        with tempfile.TemporaryDirectory() as td:
            self._init_repo(td)

            # Base commit with passing test
            lines = ["def add(a, b):", "    return a + b"] + [""] * 25
            with open(os.path.join(td, "calc.py"), "w") as f:
                f.write("\n".join(lines) + "\n")
            with open(os.path.join(td, "test_calc.py"), "w") as f:
                f.write(
                    "import unittest\nfrom calc import add\n\n"
                    "class TestCalc(unittest.TestCase):\n"
                    "    def test_add(self):\n"
                    "        self.assertEqual(add(1, 2), 3)\n"
                )
            base_sha = self._commit(td, "base with test")

            # Head A: non-breaking edit at top of calc.py
            lines_a = ["# Agent A comment", "def add(a, b):", "    return a + b"] + [""] * 25
            with open(os.path.join(td, "calc.py"), "w") as f:
                f.write("\n".join(lines_a) + "\n")
            head_a_sha = self._commit(td, "agent A clean edit")

            # Head B: non-breaking edit at bottom of calc.py
            subprocess.run(["git", "-C", td, "checkout", "-b", "branch-b", base_sha], check=True, capture_output=True)
            lines_b = lines + ["def helper():", "    return True", ""]
            with open(os.path.join(td, "calc.py"), "w") as f:
                f.write("\n".join(lines_b) + "\n")
            head_b_sha = self._commit(td, "agent B clean edit")

            engine = RadarEngine(
                repo_path=td,
                test_command=[sys.executable, "-m", "unittest", "discover", "-s", "."],
            )
            res = engine.evaluate_pair(
                AgentHead("agent-1", head_a_sha, base_sha=base_sha),
                AgentHead("agent-2", head_b_sha, base_sha=base_sha),
            )

            # Overlapping calc.py, tests ran, 1 test passed -> strictly 'clean'
            self.assertEqual(res.status, STATUS_CLEAN)
            self.assertEqual(res, "clean")
            self.assertTrue(res.is_clean)
            self.assertIsNone(res.warning)
            self.assertIsNone(res.kind)
            self.assertGreater(res.evidence.get("tests_collected", 0), 0)

            # Report check
            rep = res.report()
            self.assertEqual(rep["status"], "clean")
            self.assertIsNone(rep["kind"])

    def test_2_overlapping_conflicting_commits_same_line(self):
        """Test 2: Overlapping conflicting commits on same line -> returns status='conflict', kind='textual'."""
        with tempfile.TemporaryDirectory() as td:
            self._init_repo(td)

            # Base commit
            with open(os.path.join(td, "shared.txt"), "w") as f:
                f.write("line 1: initial shared content\nline 2: stable footer\n")
            base_sha = self._commit(td, "base commit")

            # Head A: change line 1
            with open(os.path.join(td, "shared.txt"), "w") as f:
                f.write("line 1: agent A altered this\nline 2: stable footer\n")
            head_a_sha = self._commit(td, "agent A edit")

            # Head B: checkout base, change line 1 differently
            subprocess.run(["git", "-C", td, "checkout", "-b", "branch-b", base_sha], check=True, capture_output=True)
            with open(os.path.join(td, "shared.txt"), "w") as f:
                f.write("line 1: agent B altered this\nline 2: stable footer\n")
            head_b_sha = self._commit(td, "agent B edit")

            engine = RadarEngine(repo_path=td)
            head_a = AgentHead(id="agent-A", sha=head_a_sha, base_sha=base_sha)
            head_b = AgentHead(id="agent-B", sha=head_b_sha, base_sha=base_sha)

            res = engine.evaluate_pair(head_a, head_b)

            # Assertions: textual conflict
            self.assertEqual(res.status, STATUS_CONFLICT)
            self.assertEqual(res, "conflict")
            self.assertTrue(res.is_conflict)
            self.assertEqual(res.kind, "textual")
            self.assertIsNotNone(res.warning)
            self.assertEqual(res.warning["kind"], "textual")
            self.assertIn("shared.txt", res.warning["evidence"]["conflicting_files"])
            self.assertTrue(res.warning["warning_id"].startswith("01a1warn-"))

            # Report check
            rep = res.report()
            self.assertEqual(rep["status"], "conflict")
            self.assertEqual(rep["kind"], "textual")
            self.assertIn("conflicting_files", rep["evidence"])

    def test_3_clean_textual_merge_broken_semantic_contract(self):
        """Test 3: Clean textual merge but broken semantic contract -> returns status='conflict', kind='test'."""
        with tempfile.TemporaryDirectory() as td:
            self._init_repo(td)

            # Base commit: math service and unit test
            code = (
                "def compute(x: int) -> int:\n"
                "    return x * 2\n"
                "\n"
                "\n"
                "\n"
                "\n"
                "\n"
                "\n"
                "\n"
                "\n"
            )
            test_code = (
                "import unittest\n"
                "from service import compute\n\n"
                "class TestService(unittest.TestCase):\n"
                "    def test_compute(self):\n"
                "        self.assertEqual(compute(10), 20)\n"
            )
            with open(os.path.join(td, "service.py"), "w") as f:
                f.write(code)
            with open(os.path.join(td, "test_service.py"), "w") as f:
                f.write(test_code)
            base_sha = self._commit(td, "base commit")

            # Head A: changes compute to return x * 3 (semantic break at top of file)
            mod_code_a = (
                "def compute(x: int) -> int:\n"
                "    return x * 3\n"
                "\n"
                "\n"
                "\n"
                "\n"
                "\n"
                "\n"
                "\n"
                "\n"
            )
            with open(os.path.join(td, "service.py"), "w") as f:
                f.write(mod_code_a)
            head_a_sha = self._commit(td, "agent A semantic break")

            # Head B: modifies service.py at bottom (adds helper function, clean textual merge)
            subprocess.run(["git", "-C", td, "checkout", "-b", "branch-b", base_sha], check=True, capture_output=True)
            mod_code_b = (
                "def compute(x: int) -> int:\n"
                "    return x * 2\n"
                "\n"
                "\n"
                "\n"
                "\n"
                "\n"
                "\n"
                "\n"
                "def helper() -> str:\n"
                "    return 'ok'\n"
            )
            with open(os.path.join(td, "service.py"), "w") as f:
                f.write(mod_code_b)
            head_b_sha = self._commit(td, "agent B non-conflicting edit")

            engine = RadarEngine(
                repo_path=td,
                test_command=[sys.executable, "-m", "unittest", "discover", "-s", "."],
                test_budget_seconds=15.0,
            )
            head_a = AgentHead(id="agent-A", sha=head_a_sha, base_sha=base_sha)
            head_b = AgentHead(id="agent-B", sha=head_b_sha, base_sha=base_sha)

            res = engine.evaluate_pair(head_a, head_b)

            # Assertions: test failure -> conflict, kind='test'
            self.assertEqual(res.status, STATUS_CONFLICT)
            self.assertEqual(res, "conflict")
            self.assertTrue(res.is_conflict)
            self.assertEqual(res.kind, "test")
            self.assertIsNotNone(res.warning)
            self.assertEqual(res.warning["kind"], "test")

            # Verify evidence captured test failure details
            ev = res.warning["evidence"]
            self.assertNotEqual(ev["exit_code"], 0)
            self.assertTrue("AssertionError" in ev["stderr"] or "FAIL" in ev["stderr"])

            # Report check
            rep = res.report()
            self.assertEqual(rep["status"], "conflict")
            self.assertEqual(rep["kind"], "test")

    def test_4_missing_commit_object_fail_closed(self):
        """Test 4: Missing commit object -> returns 'unknown' (fail-closed, never safe)."""
        with tempfile.TemporaryDirectory() as td:
            self._init_repo(td)

            with open(os.path.join(td, "main.txt"), "w") as f:
                f.write("hello\n")
            base_sha = self._commit(td, "base commit")

            with open(os.path.join(td, "main.txt"), "w") as f:
                f.write("hello world\n")
            valid_sha = self._commit(td, "valid commit")

            engine = RadarEngine(repo_path=td)

            # Missing head SHA
            missing_sha = "0123456789abcdef0123456789abcdef01234567"
            res = engine.evaluate_pair(
                AgentHead(id="agent-valid", sha=valid_sha, base_sha=base_sha),
                AgentHead(id="agent-missing", sha=missing_sha, base_sha=base_sha),
            )

            self.assertEqual(res.status, STATUS_UNKNOWN)
            self.assertEqual(res, "unknown")
            self.assertTrue(res.is_unknown)
            self.assertFalse(res.is_clean)
            self.assertIsNone(res.warning)
            self.assertIn("Missing commit object", res.error)

            rep = res.report()
            self.assertEqual(rep["status"], "unknown")
            self.assertIsNone(rep["kind"])

    def test_5_zero_collected_tests_returns_unknown(self):
        """Test 5: If test discovery runs 0 tests, do NOT treat exit 0 as clean! Mark as 'unknown'."""
        with tempfile.TemporaryDirectory() as td:
            self._init_repo(td)

            # Base commit: python file without any tests
            lines = ["x = 1"] + [""] * 25
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("\n".join(lines) + "\n")
            # Create an empty test file or no test cases
            with open(os.path.join(td, "test_empty.py"), "w") as f:
                f.write("# No test cases in here\n")
            base_sha = self._commit(td, "base with empty test file")

            # Head A: edits top of app.py
            lines_a = ["x = 2"] + [""] * 25
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("\n".join(lines_a) + "\n")
            hA = self._commit(td, "headA")

            # Head B: edits bottom of app.py
            subprocess.run(["git", "-C", td, "checkout", "-b", "branch-b", base_sha], check=True, capture_output=True)
            lines_b = lines + ["y = 3", ""]
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("\n".join(lines_b) + "\n")
            hB = self._commit(td, "headB")

            engine = RadarEngine(
                repo_path=td,
                test_command=[sys.executable, "-m", "unittest", "discover", "-s", "."],
            )
            res = engine.evaluate_pair(
                AgentHead("agent-A", hA, base_sha=base_sha),
                AgentHead("agent-B", hB, base_sha=base_sha),
            )

            # Overlapping app.py, clean textual merge, but 0 tests collected -> strictly 'unknown'!
            self.assertEqual(res.status, STATUS_UNKNOWN)
            self.assertEqual(res, "unknown")
            self.assertTrue(res.is_unknown)
            self.assertFalse(res.is_clean)
            self.assertEqual(res.evidence.get("error"), "no_tests_collected")

            rep = res.report()
            self.assertEqual(rep["status"], "unknown")
            self.assertIsNone(rep["kind"])

    def test_5b_unparseable_exit_zero_command_returns_unknown(self):
        """Test 5b: Command exiting 0 without test count evidence (e.g. echo) -> strictly 'unknown' (never 'clean')."""
        with tempfile.TemporaryDirectory() as td:
            self._init_repo(td)

            lines = ["x = 1"] + [""] * 25
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("\n".join(lines) + "\n")
            base_sha = self._commit(td, "base")

            lines_a = ["x = 2"] + [""] * 25
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("\n".join(lines_a) + "\n")
            hA = self._commit(td, "headA")

            subprocess.run(["git", "-C", td, "checkout", "-b", "branch-b", base_sha], check=True, capture_output=True)
            lines_b = lines + ["y = 3", ""]
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("\n".join(lines_b) + "\n")
            hB = self._commit(td, "headB")

            engine = RadarEngine(
                repo_path=td,
                test_command=["echo", "Success without counts"],
            )
            res = engine.evaluate_pair(
                AgentHead("agent-A", hA, base_sha=base_sha),
                AgentHead("agent-B", hB, base_sha=base_sha),
            )

            # Strict fail-closed check: No test count evidence -> MUST be 'unknown', NEVER 'clean'
            self.assertEqual(res.status, STATUS_UNKNOWN)
            self.assertEqual(res, "unknown")
            self.assertTrue(res.is_unknown)
            self.assertFalse(res.is_clean)
            self.assertNotEqual(res.status, STATUS_CLEAN)
            self.assertEqual(res.evidence.get("error"), "no_collected_test_evidence")
            self.assertEqual(res.evidence.get("tests_collected"), 0)

    def test_5c_bin_true_command_returns_unknown(self):
        """Test 5c: /bin/true exiting 0 with no counts -> strictly 'unknown' (never 'clean')."""
        with tempfile.TemporaryDirectory() as td:
            self._init_repo(td)

            lines = ["x = 1"] + [""] * 25
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("\n".join(lines) + "\n")
            base_sha = self._commit(td, "base")

            lines_a = ["x = 2"] + [""] * 25
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("\n".join(lines_a) + "\n")
            hA = self._commit(td, "headA")

            subprocess.run(["git", "-C", td, "checkout", "-b", "branch-b", base_sha], check=True, capture_output=True)
            lines_b = lines + ["y = 3", ""]
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("\n".join(lines_b) + "\n")
            hB = self._commit(td, "headB")

            engine = RadarEngine(
                repo_path=td,
                test_command=["/bin/true"],
            )
            res = engine.evaluate_pair(
                AgentHead("agent-A", hA, base_sha=base_sha),
                AgentHead("agent-B", hB, base_sha=base_sha),
            )

            # /bin/true produces 0 output and no counts -> MUST be 'unknown'
            self.assertEqual(res.status, STATUS_UNKNOWN)
            self.assertEqual(res, "unknown")
            self.assertTrue(res.is_unknown)
            self.assertFalse(res.is_clean)
            self.assertNotEqual(res.status, STATUS_CLEAN)
            self.assertEqual(res.evidence.get("error"), "no_collected_test_evidence")

    def test_5d_genuine_test_output_with_ran_3_tests_returns_clean(self):
        """Test 5d: Genuine test output reporting 'Ran 3 tests in ... OK' -> strictly 'clean'."""
        with tempfile.TemporaryDirectory() as td:
            self._init_repo(td)

            lines = ["x = 1"] + [""] * 25
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("\n".join(lines) + "\n")
            # Create a test file with 3 passing tests
            test_content = (
                "import unittest\n\n"
                "class TriTest(unittest.TestCase):\n"
                "    def test_1(self): self.assertTrue(True)\n"
                "    def test_2(self): self.assertTrue(True)\n"
                "    def test_3(self): self.assertTrue(True)\n"
            )
            with open(os.path.join(td, "test_app.py"), "w") as f:
                f.write(test_content)
            base_sha = self._commit(td, "base with 3 tests")

            lines_a = ["x = 2"] + [""] * 25
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("\n".join(lines_a) + "\n")
            hA = self._commit(td, "headA")

            subprocess.run(["git", "-C", td, "checkout", "-b", "branch-b", base_sha], check=True, capture_output=True)
            lines_b = lines + ["y = 3", ""]
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("\n".join(lines_b) + "\n")
            hB = self._commit(td, "headB")

            engine = RadarEngine(
                repo_path=td,
                test_command=[sys.executable, "-m", "unittest", "discover", "-s", "."],
            )
            res = engine.evaluate_pair(
                AgentHead("agent-A", hA, base_sha=base_sha),
                AgentHead("agent-B", hB, base_sha=base_sha),
            )

            # Genuine positive test evidence with 3 tests -> strictly 'clean'
            self.assertEqual(res.status, STATUS_CLEAN)
            self.assertEqual(res, "clean")
            self.assertTrue(res.is_clean)
            self.assertFalse(res.is_unknown)
            self.assertEqual(res.evidence.get("tests_collected"), 3)

    def test_6_process_hang_timeout_kills_process_group(self):
        """Test 6: Process hang / timeout strictly kills process group and returns 'unknown'."""
        with tempfile.TemporaryDirectory() as td:
            self._init_repo(td)

            # Create test that spawns a long-running child process and sleeps
            pid_file = os.path.join(td, "child_spawned.pid")
            test_content = (
                f"import subprocess, time, unittest\n"
                f"class HangTest(unittest.TestCase):\n"
                f"    def test_hang(self):\n"
                f"        p = subprocess.Popen(['sleep', '100'])\n"
                f"        with open('{pid_file}', 'w') as f:\n"
                f"            f.write(str(p.pid))\n"
                f"        time.sleep(100)\n"
            )

            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("val = 1\n\n\n\n\n\n\n\n\n")
            with open(os.path.join(td, "test_hang.py"), "w") as f:
                f.write(test_content)
            base_sha = self._commit(td, "base with hang test")

            # Head A
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("val = 2\n\n\n\n\n\n\n\n\n")
            hA = self._commit(td, "headA")

            # Head B
            subprocess.run(["git", "-C", td, "checkout", "-b", "branch-b", base_sha], check=True, capture_output=True)
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("val = 1\n\n\n\n\n\n\n\n\nval2 = 3\n")
            hB = self._commit(td, "headB")

            # Run with tight timeout budget: 0.1s
            engine = RadarEngine(
                repo_path=td,
                test_command=[sys.executable, "-m", "unittest", "discover", "-s", "."],
                test_budget_seconds=0.2,
            )

            res = engine.evaluate_pair(
                AgentHead("agent-A", hA, base_sha=base_sha),
                AgentHead("agent-B", hB, base_sha=base_sha),
            )

            # Must return unknown
            self.assertEqual(res.status, STATUS_UNKNOWN)
            self.assertEqual(res, "unknown")
            self.assertTrue(res.is_unknown)
            self.assertIn("timed out", res.evidence.get("details", "").lower())

            # Check if child process was spawned and verify it was killed by process group kill
            time.sleep(0.1)
            if os.path.exists(pid_file):
                with open(pid_file) as f:
                    child_pid = int(f.read().strip())
                # Child process must NOT be alive
                is_alive = os.path.exists(f"/proc/{child_pid}")
                self.assertFalse(is_alive, f"Child process {child_pid} was not killed with process group!")

    def test_7_safe_archive_extraction_rejects_traversal(self):
        """Test 7: Safe archive extraction strictly rejects traversal, absolute paths, and special files (D5)."""
        with tempfile.TemporaryDirectory() as td:
            # 1. Traversal: ../escape.txt
            bio = io.BytesIO()
            with tarfile.open(fileobj=bio, mode="w") as tar:
                ti = tarfile.TarInfo(name="../escape.txt")
                content = b"malicious content"
                ti.size = len(content)
                tar.addfile(ti, io.BytesIO(content))
            bio.seek(0)
            with self.assertRaises(RuntimeError) as ctx:
                safe_extract_tar(bio.read(), td)
            self.assertIn("Directory traversal", str(ctx.exception))

            # 2. Absolute path: /etc/evil.txt
            bio_abs = io.BytesIO()
            with tarfile.open(fileobj=bio_abs, mode="w") as tar:
                ti = tarfile.TarInfo(name="/etc/evil.txt")
                ti.size = 4
                tar.addfile(ti, io.BytesIO(b"evil"))
            bio_abs.seek(0)
            with self.assertRaises(RuntimeError) as ctx:
                safe_extract_tar(bio_abs.read(), td)
            self.assertIn("Absolute path rejected", str(ctx.exception))

            # 3. Special file: FIFO
            bio_fifo = io.BytesIO()
            with tarfile.open(fileobj=bio_fifo, mode="w") as tar:
                ti = tarfile.TarInfo(name="my_device_fifo")
                ti.type = tarfile.FIFOTYPE
                tar.addfile(ti)
            bio_fifo.seek(0)
            with self.assertRaises(RuntimeError) as ctx:
                safe_extract_tar(bio_fifo.read(), td)
            self.assertIn("Special file rejected", str(ctx.exception))

    def test_8_matrix_computation_and_bounding(self):
        """Test matrix computation across active head vectors with deterministic bounding."""
        with tempfile.TemporaryDirectory() as td:
            self._init_repo(td)

            # Base commit
            with open(os.path.join(td, "f1.txt"), "w") as f:
                f.write("base 1\n")
            with open(os.path.join(td, "f2.txt"), "w") as f:
                f.write("base 2\n")
            with open(os.path.join(td, "f3.txt"), "w") as f:
                f.write("base 3\n")
            base_sha = self._commit(td, "base")

            # Head 1: edits f1
            with open(os.path.join(td, "f1.txt"), "w") as f:
                f.write("head 1 edit\n")
            h1 = self._commit(td, "h1")

            # Head 2: edits f2 (disjoint with h1)
            subprocess.run(["git", "-C", td, "checkout", "-b", "b2", base_sha], check=True, capture_output=True)
            with open(os.path.join(td, "f2.txt"), "w") as f:
                f.write("head 2 edit\n")
            h2 = self._commit(td, "h2")

            # Head 3: edits f1 line 1 (conflicts with h1)
            subprocess.run(["git", "-C", td, "checkout", "-b", "b3", base_sha], check=True, capture_output=True)
            with open(os.path.join(td, "f1.txt"), "w") as f:
                f.write("head 3 conflicting edit\n")
            h3 = self._commit(td, "h3")

            engine = RadarEngine(repo_path=td, max_active_heads=10)
            heads = [
                AgentHead("agent-1", h1, base_sha=base_sha),
                AgentHead("agent-2", h2, base_sha=base_sha),
                AgentHead("agent-3", h3, base_sha=base_sha),
            ]

            matrix_res = engine.run_matrix(heads, base_sha=base_sha)

            # 3 heads -> 3 pairwise combinations: (1,2), (1,3), (2,3)
            self.assertEqual(matrix_res.summary["active_heads"], 3)
            self.assertEqual(matrix_res.summary["total_pairs"], 3)
            # h1+h2 disjoint -> not_checked
            # h1+h3 conflict -> conflict
            # h2+h3 disjoint -> not_checked
            self.assertEqual(matrix_res.summary["not_checked_pairs"], 2)
            self.assertEqual(matrix_res.summary["conflict_pairs"], 1)
            self.assertEqual(len(matrix_res.warnings), 1)
            self.assertEqual(matrix_res.warnings[0]["kind"], "textual")

            # Verify bounding: limit to 2 heads
            bounded_matrix = engine.run_matrix(heads, base_sha=base_sha, max_active_heads=2)
            self.assertEqual(bounded_matrix.summary["active_heads"], 2)
            self.assertEqual(bounded_matrix.summary["total_pairs"], 1)

            # Verify JSON serialization
            d = matrix_res.to_dict()
            json_str = json.dumps(d)
            self.assertTrue(len(json_str) > 0)

    def test_export_l1_payload_v01_contract(self):
        """Test CONTRACT v0.1 export adapter for L1 integration (C-1321)."""
        engine = RadarEngine(
            test_command=["python3", "-m", "unittest", "discover"],
            test_budget_seconds=15.0,
        )

        # 1. Conflict (textual) - intentionally reversed pair ["agent-Z", "agent-A"]
        pair_conflict = PairResult(
            status=STATUS_CONFLICT,
            kind="textual",
            pair=["agent-Z", "agent-A"],
            heads={"agent-Z": "sha_z", "agent-A": "sha_a"},
            overlapping_files=["app.py"],
            evidence={
                "conflicting_files": ["app.py"],
                "details": "Merge conflict in app.py",
            },
        )

        # 2. Clean (with positive tests_collected=5)
        pair_clean = PairResult(
            status=STATUS_CLEAN,
            kind=None,
            pair=["agent-B", "agent-C"],
            heads={"agent-B": "sha_b", "agent-C": "sha_c"},
            overlapping_files=["calc.py"],
            evidence={
                "exit_code": 0,
                "tests_collected": 5,
                "details": "Ran 5 tests in 0.05s OK",
                "stdout": "Ran 5 tests in 0.05s\nOK",
            },
        )

        # 3. Unknown (timeout/error)
        pair_unknown = PairResult(
            status=STATUS_UNKNOWN,
            kind=None,
            pair=["agent-D", "agent-E"],
            heads={"agent-D": "sha_d", "agent-E": "sha_e"},
            evidence={
                "error": "timeout",
                "details": "Process timed out after 15s",
                "stderr": "TimeoutExpired",
            },
        )

        # 4. Not checked (disjoint commits without tests)
        pair_not_checked = PairResult(
            status=STATUS_NOT_CHECKED,
            kind=None,
            pair=["agent-F", "agent-G"],
            heads={"agent-F": "sha_f", "agent-G": "sha_g"},
            overlapping_files=[],
            evidence={
                "reason": "disjoint_no_tests",
                "details": "Disjoint files without tests",
            },
        )

        pairs = [pair_conflict, pair_clean, pair_unknown, pair_not_checked]

        # Case A: Export via engine method (deriving vector automatically)
        payload = engine.export_l1_payload(pairs)

        # Check top-level contract
        self.assertEqual(payload["contract"], "0.1")

        # Check vector: derived from all heads, sorted by key
        expected_vector = {
            "agent-A": "sha_a",
            "agent-B": "sha_b",
            "agent-C": "sha_c",
            "agent-D": "sha_d",
            "agent-E": "sha_e",
            "agent-F": "sha_f",
            "agent-G": "sha_g",
            "agent-Z": "sha_z",
        }
        self.assertEqual(payload["vector"], expected_vector)

        # Check policy
        self.assertEqual(payload["policy"]["merge"], "git-merge-tree")
        self.assertEqual(payload["policy"]["tests"]["command"], ["python3", "-m", "unittest", "discover"])
        self.assertEqual(payload["policy"]["tests"]["budget_s"], 15.0)

        # Check coverage: 3 checked ('conflict', 'clean', 'unknown'), not_checked excluded
        self.assertEqual(payload["coverage"]["pairs_checked"], 3)
        self.assertEqual(payload["coverage"]["tests_collected"], 5)

        # Check results
        results = payload["results"]
        self.assertEqual(len(results), 4)

        # Verify deterministic pair sorting: pair[0] <= pair[1]
        for r in results:
            self.assertEqual(len(r["pair"]), 2)
            self.assertLessEqual(r["pair"][0], r["pair"][1])
            # heads matches pair keys
            self.assertEqual(list(r["heads"].keys()), r["pair"])
            # summary is non-empty string
            self.assertTrue(isinstance(r["evidence"]["summary"], str) and len(r["evidence"]["summary"]) > 0)
            # files is a list
            self.assertTrue(isinstance(r["evidence"]["files"], list))

        # Check specific items
        # Result 1: pair ["agent-A", "agent-Z"] (sorted from ["agent-Z", "agent-A"])
        r_az = results[0]
        self.assertEqual(r_az["pair"], ["agent-A", "agent-Z"])
        self.assertEqual(r_az["status"], "conflict")
        self.assertEqual(r_az["kind"], "textual")
        self.assertEqual(r_az["heads"], {"agent-A": "sha_a", "agent-Z": "sha_z"})
        self.assertEqual(r_az["evidence"]["files"], ["app.py"])
        self.assertIn("conflict", r_az["evidence"]["summary"].lower())

        # Result 2: clean with tests_collected=5
        r_bc = results[1]
        self.assertEqual(r_bc["pair"], ["agent-B", "agent-C"])
        self.assertEqual(r_bc["status"], "clean")
        self.assertEqual(r_bc["kind"], None)
        self.assertEqual(r_bc["evidence"]["tests_collected"], 5)
        self.assertEqual(r_bc["evidence"]["exit_code"], 0)
        self.assertIn("Ran 5 tests", r_bc["evidence"]["test_output_tail"])

        # Result 3: unknown with timeout
        r_de = results[2]
        self.assertEqual(r_de["pair"], ["agent-D", "agent-E"])
        self.assertEqual(r_de["status"], "unknown")
        self.assertEqual(r_de["evidence"]["error"], "timeout")
        self.assertEqual(r_de["evidence"]["test_output_tail"], "TimeoutExpired")

        # Result 4: not_checked
        r_fg = results[3]
        self.assertEqual(r_fg["pair"], ["agent-F", "agent-G"])
        self.assertEqual(r_fg["status"], "not_checked")
        self.assertEqual(r_fg["evidence"]["files"], [])

        # Case B: Explicit vector provided
        explicit_vec = {"agent-B": "custom_b", "agent-C": "custom_c"}
        payload_b = export_l1_payload([pair_clean], vector=explicit_vec, engine=engine)
        self.assertEqual(payload_b["vector"], explicit_vec)
        self.assertEqual(payload_b["coverage"]["pairs_checked"], 1)
        self.assertEqual(payload_b["coverage"]["tests_collected"], 5)

    def test_ram_admission_gate_insufficient_memory_returns_unknown(self):
        """Test RAM admission gate blocks job and returns unknown when memory is insufficient."""
        with tempfile.TemporaryDirectory() as td:
            self._init_repo(td)

            # Base commit
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("x = 1\n" + "\n" * 25)
            with open(os.path.join(td, "test_app.py"), "w") as f:
                f.write("import unittest\nclass T(unittest.TestCase):\n    def test_ok(self): self.assertTrue(True)\n")
            base_sha = self._commit(td, "base")

            # Head A
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("x = 2\n" + "\n" * 25)
            hA = self._commit(td, "headA")

            # Head B
            subprocess.run(["git", "-C", td, "checkout", "-b", "bB", base_sha], check=True, capture_output=True)
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("x = 1\n" + "\n" * 25 + "y = 3\n")
            hB = self._commit(td, "headB")

            # Set impossible memory threshold 999999 MB and tight queue timeout 0.1s
            engine = RadarEngine(
                repo_path=td,
                test_command=[sys.executable, "-m", "unittest", "discover", "-s", "."],
                min_mem_available_mb=999999.0,
                queue_timeout_seconds=0.1,
            )

            res = engine.evaluate_pair(
                AgentHead("agent-A", hA, base_sha=base_sha),
                AgentHead("agent-B", hB, base_sha=base_sha),
            )

            self.assertEqual(res.status, "unknown")
            self.assertEqual(res.kind, "test")
            self.assertEqual(res.evidence.get("summary"), "resource-skipped: insufficient memory")
            self.assertEqual(res.evidence.get("reserve_mb"), 999999.0)
            self.assertEqual(res.evidence.get("required_mb"), 512.0)
            self.assertIn("wait_time_seconds", res.evidence)

    def test_ram_admission_gate_healthy_memory_runs_and_records_telemetry(self):
        """Test RAM admission gate runs tests and records RSS & wait telemetry when memory is healthy."""
        with tempfile.TemporaryDirectory() as td:
            self._init_repo(td)

            # Base commit
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("x = 1\n" + "\n" * 25)
            with open(os.path.join(td, "test_app.py"), "w") as f:
                f.write("import unittest\nclass T(unittest.TestCase):\n    def test_1(self): self.assertTrue(True)\n")
            base_sha = self._commit(td, "base")

            # Head A
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("x = 2\n" + "\n" * 25)
            hA = self._commit(td, "headA")

            # Head B
            subprocess.run(["git", "-C", td, "checkout", "-b", "bB", base_sha], check=True, capture_output=True)
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("x = 1\n" + "\n" * 25 + "y = 3\n")
            hB = self._commit(td, "headB")

            # Set normal threshold (50 MB)
            engine = RadarEngine(
                repo_path=td,
                test_command=[sys.executable, "-m", "unittest", "discover", "-s", "."],
                min_mem_available_mb=50.0,
                queue_timeout_seconds=5.0,
            )

            res = engine.evaluate_pair(
                AgentHead("agent-A", hA, base_sha=base_sha),
                AgentHead("agent-B", hB, base_sha=base_sha),
            )

            self.assertEqual(res.status, "clean")
            self.assertEqual(res.evidence.get("tests_collected"), 1)
            self.assertIn("peak_rss_mb", res.evidence)
            self.assertIn("wait_time_seconds", res.evidence)
            self.assertGreaterEqual(res.evidence["peak_rss_mb"], 0.0)
            self.assertGreaterEqual(res.evidence["wait_time_seconds"], 0.0)

    def test_ram_admission_gate_psi_pressure_returns_unknown(self):
        """Test PSI memory pressure gate skips execution when pressure is high (01a101e4)."""
        with tempfile.TemporaryDirectory() as td:
            self._init_repo(td)

            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("x = 1\n" + "\n" * 25)
            with open(os.path.join(td, "test_app.py"), "w") as f:
                f.write("import unittest\nclass T(unittest.TestCase):\n    def test_ok(self): self.assertTrue(True)\n")
            base_sha = self._commit(td, "base")

            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("x = 2\n" + "\n" * 25)
            hA = self._commit(td, "headA")

            subprocess.run(["git", "-C", td, "checkout", "-b", "bB", base_sha], check=True, capture_output=True)
            with open(os.path.join(td, "app.py"), "w") as f:
                f.write("x = 1\n" + "\n" * 25 + "y = 3\n")
            hB = self._commit(td, "headB")

            # Set max_psi_some_avg10 to -1.0 so any non-negative PSI reading triggers pressure skip
            engine = RadarEngine(
                repo_path=td,
                test_command=[sys.executable, "-m", "unittest", "discover", "-s", "."],
                min_mem_available_mb=10.0,
                max_psi_some_avg10=-1.0,
                queue_timeout_seconds=0.1,
            )

            res = engine.evaluate_pair(
                AgentHead("agent-A", hA, base_sha=base_sha),
                AgentHead("agent-B", hB, base_sha=base_sha),
            )

            from radar.engine import get_psi_memory_some_avg10
            if get_psi_memory_some_avg10() is not None:
                self.assertEqual(res.status, "unknown")
                self.assertEqual(res.kind, "test")
                self.assertEqual(res.evidence.get("summary"), "resource-skipped: high memory pressure")


if __name__ == "__main__":
    unittest.main()
