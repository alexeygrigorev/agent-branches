"""Unit tests for `branches sync git` functionality."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from agent_branches.sync_git import (
    sync_git,
    is_forbidden,
    get_status_entries,
    get_staged_entries,
    repo_lock,
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

    def test_noop_when_clean_and_in_sync(self):
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

    def test_pre_staged_secret_rejected(self):
        # Explicitly stage a forbidden secret into git index
        secret_file = os.path.join(self.test_dir, ".env")
        with open(secret_file, "w") as f:
            f.write("SECRET_KEY=leak\n")
        subprocess.run(["git", "add", ".env"], cwd=self.test_dir, check=True)

        # sync_git must detect staged secret and abort with SecretLeakageError
        with self.assertRaises(SecretLeakageError):
            sync_git(self.test_dir)

    def test_push_failure_preserves_local_checkpoint(self):
        # Create a new commit to push
        new_file = os.path.join(self.test_dir, "model.py")
        with open(new_file, "w") as f:
            f.write("class Model: pass\n")

        # Point origin to a nonexistent path so git push fails naturally
        subprocess.run(
            ["git", "remote", "set-url", "origin", "/nonexistent/remote/path"],
            cwd=self.test_dir,
            check=True,
        )

        res = sync_git(self.test_dir, message="feat: checkpoint commit")

        self.assertEqual(res["status"], "unpushed_checkpoint")
        self.assertFalse(res["verified"])
        self.assertFalse(res["in_sync"])

        # Crucial check: verify git commit was NOT reset/rolled back
        log_res = subprocess.run(
            ["git", "log", "-n", "1", "--format=%s"],
            cwd=self.test_dir,
            capture_output=True,
            text=True,
        )
        self.assertEqual(log_res.stdout.strip(), "feat: checkpoint commit")

    def test_clean_ahead_pushes_to_remote(self):
        # Create commit directly with git, leaving working tree clean but ahead of origin
        new_file = os.path.join(self.test_dir, "ahead.py")
        with open(new_file, "w") as f:
            f.write("# ahead\n")
        subprocess.run(["git", "add", "ahead.py"], cwd=self.test_dir, check=True)
        subprocess.run(["git", "commit", "-m", "commit ahead of remote"], cwd=self.test_dir, check=True)

        local_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.test_dir, capture_output=True, text=True
        ).stdout.strip()

        # sync_git should detect working tree clean but ahead, and push
        res = sync_git(self.test_dir)
        self.assertEqual(res["status"], "synced")
        self.assertTrue(res["verified"])
        self.assertEqual(res["head_sha"], local_sha)
        self.assertEqual(res["remote_sha"], local_sha)

    def test_remote_mismatch_returns_push_unverified(self):
        new_file = os.path.join(self.test_dir, "mismatch.py")
        with open(new_file, "w") as f:
            f.write("# test mismatch\n")

        with patch("agent_branches.sync_git.get_remote_sha") as mock_remote:
            mock_remote.return_value = "0000000000000000000000000000000000000000"
            res = sync_git(self.test_dir)
            self.assertEqual(res["status"], "push_unverified")
            self.assertFalse(res["verified"])
            self.assertFalse(res["in_sync"])

    def test_porcelain_z_special_character_paths(self):
        # Create filename with spaces and unicode
        special_name = "test special spaced file.py"
        with open(os.path.join(self.test_dir, special_name), "w") as f:
            f.write("# special\n")

        modified, untracked_safe, untracked_forbidden = get_status_entries(self.test_dir)
        self.assertIn(special_name, untracked_safe)

    def test_repo_lock_concurrency(self):
        with repo_lock(self.test_dir):
            lock_path = Path(self.test_dir) / ".local" / "git.lock"
            self.assertTrue(lock_path.exists())


if __name__ == "__main__":
    unittest.main()
