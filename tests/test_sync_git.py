"""Unit tests for `branches sync git` functionality."""

import os
import shutil
import subprocess
import tempfile
import unittest

from agent_branches.sync_git import (
    sync_git,
    is_forbidden,
    get_status_entries,
    SecretLeakageError,
    SyncGitError,
)


class TestSyncGit(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.remote_dir = tempfile.mkdtemp()

        # Initialize bare remote
        subprocess.run(["git", "init", "--bare", self.remote_dir], check=True, capture_output=True)

        # Initialize local repo
        subprocess.run(["git", "init", "-b", "main", self.test_dir], check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.name", "Test Agent"],
            cwd=self.test_dir,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.email", "agent@test.local"],
            cwd=self.test_dir,
            check=True,
        )
        subprocess.run(
            ["git", "remote", "add", "origin", self.remote_dir],
            cwd=self.test_dir,
            check=True,
        )

        # Initial commit
        init_file = os.path.join(self.test_dir, "README.md")
        with open(init_file, "w") as f:
            f.write("# Initial repo\n")
        subprocess.run(["git", "add", "README.md"], cwd=self.test_dir, check=True)
        subprocess.run(["git", "commit", "-m", "initial commit"], cwd=self.test_dir, check=True)
        subprocess.run(["git", "push", "origin", "main"], cwd=self.test_dir, check=True)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)
        shutil.rmtree(self.remote_dir, ignore_errors=True)

    def test_forbidden_patterns(self):
        self.assertTrue(is_forbidden(".env"))
        self.assertTrue(is_forbidden("config/.env.local"))
        self.assertTrue(is_forbidden(".local/state.db"))
        self.assertTrue(is_forbidden("keys/id_rsa"))
        self.assertTrue(is_forbidden("token.txt"))
        self.assertFalse(is_forbidden("agent_branches/client.py"))
        self.assertFalse(is_forbidden("tests/test_cli.py"))

    def test_preview_mode(self):
        # Create a modified file and an untracked safe file
        with open(os.path.join(self.test_dir, "README.md"), "a") as f:
            f.write("Update README.\n")
        with open(os.path.join(self.test_dir, "new_code.py"), "w") as f:
            f.write("print('hello')\n")
        with open(os.path.join(self.test_dir, ".env"), "w") as f:
            f.write("SECRET=123\n")

        res = sync_git(self.test_dir, preview=True)
        self.assertEqual(res["status"], "preview")
        self.assertIn("README.md", res["modified_tracked"])
        self.assertIn("new_code.py", res["untracked_safe_to_add"])
        self.assertIn(".env", res["forbidden_ignored"])
        self.assertEqual(res["to_stage_count"], 2)

    def test_noop_when_clean(self):
        res = sync_git(self.test_dir)
        self.assertEqual(res["status"], "noop")
        self.assertTrue(res["in_sync"])

    def test_sync_commit_and_push_verified(self):
        new_file = os.path.join(self.test_dir, "feature.py")
        with open(new_file, "w") as f:
            f.write("def feature(): return True\n")

        res = sync_git(self.test_dir, message="feat: add feature")
        self.assertEqual(res["status"], "synced")
        self.assertTrue(res["verified"])
        self.assertEqual(res["head_sha"], res["remote_sha"])
        self.assertIn("feature.py", res["staged_files"])

    def test_forbidden_file_ignored_during_sync(self):
        # Create a secret file and a source file
        with open(os.path.join(self.test_dir, ".env"), "w") as f:
            f.write("TOKEN=xyz\n")
        with open(os.path.join(self.test_dir, "app.py"), "w") as f:
            f.write("# safe app\n")

        res = sync_git(self.test_dir)
        self.assertEqual(res["status"], "synced")
        self.assertIn("app.py", res["staged_files"])
        self.assertNotIn(".env", res["staged_files"])
        self.assertIn(".env", res["ignored_forbidden"])

        # Check git log does not contain .env
        log_res = subprocess.run(
            ["git", "show", "--name-only", "HEAD"],
            cwd=self.test_dir,
            capture_output=True,
            text=True,
        )
        self.assertNotIn(".env", log_res.stdout)


if __name__ == "__main__":
    unittest.main()
