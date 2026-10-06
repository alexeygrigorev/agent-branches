"""Unit tests for `branches sync git` functionality."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

from agent_branches.sync_git import (
    sync_git,
    sync_isolated_owned_paths,
    is_forbidden,
    get_status_entries,
    get_staged_entries,
    get_remote_sha,
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
        # Base patterns
        self.assertTrue(is_forbidden(".env"))
        self.assertTrue(is_forbidden("config/.env.local"))
        self.assertTrue(is_forbidden(".local/state.db"))
        self.assertTrue(is_forbidden("keys/id_rsa"))
        self.assertTrue(is_forbidden("token.txt"))

        # Adversarial review patterns (VULN-SEC-01, VULN-SEC-02, VULN-SEC-03, VULN-SEC-04)
        self.assertTrue(is_forbidden(".dev.vars"))
        self.assertTrue(is_forbidden("live/.dev.vars"))
        self.assertTrue(is_forbidden(".dev.vars.local"))
        self.assertTrue(is_forbidden("id_ecdsa"))
        self.assertTrue(is_forbidden("id_ed25519"))
        self.assertTrue(is_forbidden("id_dsa"))
        self.assertTrue(is_forbidden("id_ecdsa_sk"))
        self.assertTrue(is_forbidden("secrets.json"))
        self.assertTrue(is_forbidden("secret.json"))
        self.assertTrue(is_forbidden("api_key.json"))
        self.assertTrue(is_forbidden("auth_token.txt"))
        self.assertTrue(is_forbidden("service_account.json"))
        self.assertTrue(is_forbidden("service-account.json"))
        self.assertTrue(is_forbidden("client_secret.json"))
        self.assertTrue(is_forbidden(".netrc"))
        self.assertTrue(is_forbidden(".npmrc"))
        self.assertTrue(is_forbidden(".pypirc"))

        # Directory-level secret paths
        self.assertTrue(is_forbidden(".credentials/config"))
        self.assertTrue(is_forbidden(".secrets/config.json"))
        self.assertTrue(is_forbidden(".ssh/authorized_keys"))
        self.assertTrue(is_forbidden(".aws/credentials"))
        self.assertTrue(is_forbidden(".wrangler/config.json"))
        self.assertTrue(is_forbidden("__pycache__/app.cpython-310.pyc"))
        self.assertTrue(is_forbidden("node_modules/pkg/index.js"))

        # Whitelisted documentation templates (OBS-SEC-05)
        self.assertFalse(is_forbidden(".env.example"))
        self.assertFalse(is_forbidden("config/.env.example"))
        self.assertFalse(is_forbidden(".env.template"))
        self.assertFalse(is_forbidden(".env.sample"))

        # Normal clean files must not be forbidden
        self.assertFalse(is_forbidden("tokenizer.py"))
        self.assertFalse(is_forbidden("keywords.py"))
        self.assertFalse(is_forbidden("agent_branches/client.py"))
        self.assertFalse(is_forbidden("tests/test_cli.py"))
        self.assertFalse(is_forbidden("README.md"))

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
        errors = []

        def contender():
            try:
                with repo_lock(self.test_dir, timeout_sec=0.2):
                    pass
            except SyncGitError as e:
                errors.append(e)

        with repo_lock(self.test_dir, timeout_sec=2.0):
            lock_path = Path(self.test_dir) / ".local" / "git.lock"
            self.assertTrue(lock_path.exists())
            t = threading.Thread(target=contender)
            t.start()
            t.join()

        self.assertEqual(len(errors), 1)
        self.assertIn("Could not acquire repository lock", str(errors[0]))

    def test_pre_staged_new_forbidden_patterns_rejected(self):
        for bad_file in [".dev.vars", "secrets.json", "api_key.json", "auth_token.txt", "id_ecdsa"]:
            file_path = os.path.join(self.test_dir, bad_file)
            with open(file_path, "w") as f:
                f.write("sensitive data\n")
            subprocess.run(["git", "add", bad_file], cwd=self.test_dir, check=True)
            with self.assertRaises(SecretLeakageError):
                sync_git(self.test_dir)
            subprocess.run(["git", "rm", "-f", bad_file], cwd=self.test_dir, check=True)

    def test_whitelisted_env_example_can_be_synced(self):
        env_example = os.path.join(self.test_dir, ".env.example")
        with open(env_example, "w") as f:
            f.write("API_KEY=your_key_here\n")

        res = sync_git(self.test_dir, message="docs: add .env.example")
        self.assertEqual(res["status"], "synced")
        self.assertIn(".env.example", res["staged_files"])

    def test_push_timeout_handling_returns_unpushed_checkpoint(self):
        # Create a new commit to push
        new_file = os.path.join(self.test_dir, "feature_timeout.py")
        with open(new_file, "w") as f:
            f.write("# timeout test\n")

        orig_run = subprocess.run

        def mock_run(cmd, *args, **kwargs):
            if isinstance(cmd, list) and len(cmd) >= 2 and cmd[0] == "git" and cmd[1] == "push":
                raise subprocess.TimeoutExpired(cmd=cmd, timeout=60.0)
            return orig_run(cmd, *args, **kwargs)

        with patch("agent_branches.sync_git.subprocess.run", side_effect=mock_run):
            res = sync_git(self.test_dir, message="feat: push timeout test")

        self.assertEqual(res["status"], "unpushed_checkpoint")
        self.assertFalse(res["verified"])
        self.assertFalse(res["in_sync"])
        self.assertEqual(res["error"], "git push timed out after 60.0s")
        self.assertIn("timed out", res["message"])

        # Crucial check: verify git commit was preserved on HEAD
        log_res = subprocess.run(
            ["git", "log", "-n", "1", "--format=%s"],
            cwd=self.test_dir,
            capture_output=True,
            text=True,
        )
        self.assertEqual(log_res.stdout.strip(), "feat: push timeout test")

    def test_clean_ahead_push_timeout_handling(self):
        # Create commit directly with git, leaving working tree clean but ahead of origin
        new_file = os.path.join(self.test_dir, "ahead_timeout.py")
        with open(new_file, "w") as f:
            f.write("# ahead timeout\n")
        subprocess.run(["git", "add", "ahead_timeout.py"], cwd=self.test_dir, check=True)
        subprocess.run(["git", "commit", "-m", "ahead timeout commit"], cwd=self.test_dir, check=True)

        orig_run = subprocess.run

        def mock_run(cmd, *args, **kwargs):
            if isinstance(cmd, list) and len(cmd) >= 2 and cmd[0] == "git" and cmd[1] == "push":
                raise subprocess.TimeoutExpired(cmd=cmd, timeout=60.0)
            return orig_run(cmd, *args, **kwargs)

        with patch("agent_branches.sync_git.subprocess.run", side_effect=mock_run):
            res = sync_git(self.test_dir)

        self.assertEqual(res["status"], "unpushed_checkpoint")
        self.assertFalse(res["verified"])
        self.assertFalse(res["in_sync"])
        self.assertEqual(res["error"], "git push timed out after 60.0s")
        self.assertIn("Clean working tree ahead of remote, but git push timed out.", res["message"])

    def test_get_remote_sha_timeout_fail_closed(self):
        with patch("agent_branches.sync_git.subprocess.run") as mock_run:
            mock_run.side_effect = subprocess.TimeoutExpired(cmd=["git", "ls-remote"], timeout=30.0)
            sha = get_remote_sha(self.test_dir, "origin", "main")
            self.assertIsNone(sha)

    def test_sync_isolated_owned_paths_success_and_shared_checkout_untouched(self):
        # 1. Base commit and push to remote
        base_file = os.path.join(self.test_dir, "base.txt")
        with open(base_file, "w") as f:
            f.write("base content\n")
        subprocess.run(["git", "add", "base.txt"], cwd=self.test_dir, check=True)
        subprocess.run(["git", "commit", "-m", "initial commit"], cwd=self.test_dir, check=True)
        subprocess.run(["git", "push", "origin", "main"], cwd=self.test_dir, check=True)

        initial_head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.test_dir,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

        # 2. Modify owned file AND create peer dirty file in working tree
        owned_file = os.path.join(self.test_dir, "owned.txt")
        with open(owned_file, "w") as f:
            f.write("owned content v1\n")

        peer_dirty = os.path.join(self.test_dir, "peer_dirty.txt")
        with open(peer_dirty, "w") as f:
            f.write("peer uncommitted work\n")

        # 3. Execute isolated owned-path sync
        res = sync_isolated_owned_paths(
            repo_dir=self.test_dir,
            owned_paths=["owned.txt"],
            message="feat: isolated sync",
        )

        self.assertEqual(res["status"], "synced")
        self.assertTrue(res["verified"])
        self.assertTrue(res["in_sync"])
        self.assertFalse(res["shared_checkout_advanced"])
        self.assertEqual(res["shared_checkout_head"], initial_head)
        self.assertNotEqual(res["published_commit"], initial_head)

        # 4. Local checkout HEAD must be completely unchanged
        current_head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.test_dir,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        self.assertEqual(current_head, initial_head)

        # 5. Peer dirty file must remain completely uncommitted and untracked
        status_out = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=self.test_dir,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        self.assertIn("peer_dirty.txt", status_out)
        self.assertIn("?? peer_dirty.txt", status_out)

        # 6. Verify remote tip contains owned.txt but NOT peer_dirty.txt
        remote_ls = subprocess.run(
            ["git", "ls-tree", "-r", "--name-only", res["published_commit"]],
            cwd=self.test_dir,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.splitlines()
        self.assertIn("base.txt", remote_ls)
        self.assertIn("owned.txt", remote_ls)
        self.assertNotIn("peer_dirty.txt", remote_ls)

    def test_sync_isolated_owned_paths_noop(self):
        # 1. Base commit and push
        base_file = os.path.join(self.test_dir, "base.txt")
        with open(base_file, "w") as f:
            f.write("base content\n")
        subprocess.run(["git", "add", "base.txt"], cwd=self.test_dir, check=True)
        subprocess.run(["git", "commit", "-m", "initial commit"], cwd=self.test_dir, check=True)
        subprocess.run(["git", "push", "origin", "main"], cwd=self.test_dir, check=True)

        # 2. Add owned.txt and sync
        owned_file = os.path.join(self.test_dir, "owned.txt")
        with open(owned_file, "w") as f:
            f.write("version 1\n")
        res1 = sync_isolated_owned_paths(self.test_dir, owned_paths=["owned.txt"])
        self.assertEqual(res1["status"], "synced")

        # 3. Call sync again without any changes to owned.txt
        res2 = sync_isolated_owned_paths(self.test_dir, owned_paths=["owned.txt"])
        self.assertEqual(res2["status"], "noop")
        self.assertTrue(res2["in_sync"])
        self.assertTrue(res2["verified"])
        self.assertEqual(res2["published_commit"], res1["published_commit"])

    def test_sync_isolated_owned_paths_secret_forbidden(self):
        secret_file = os.path.join(self.test_dir, ".dev.vars")
        with open(secret_file, "w") as f:
            f.write("CLOUDFLARE_API_TOKEN=supersecret\n")

        with self.assertRaises(SecretLeakageError):
            sync_isolated_owned_paths(self.test_dir, owned_paths=[".dev.vars"])

    def test_sync_isolated_owned_paths_missing_owned_path(self):
        with self.assertRaises(SyncGitError) as ctx:
            sync_isolated_owned_paths(self.test_dir, owned_paths=["nonexistent_file.txt"])
        self.assertIn("Owned path does not exist on disk", str(ctx.exception))

    def test_sync_isolated_owned_paths_push_rejection_preserves_checkpoint(self):
        # 1. Base commit and push
        base_file = os.path.join(self.test_dir, "base.txt")
        with open(base_file, "w") as f:
            f.write("base content\n")
        subprocess.run(["git", "add", "base.txt"], cwd=self.test_dir, check=True)
        subprocess.run(["git", "commit", "-m", "initial commit"], cwd=self.test_dir, check=True)
        subprocess.run(["git", "push", "origin", "main"], cwd=self.test_dir, check=True)

        initial_head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.test_dir,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

        # 2. Modify owned file
        owned_file = os.path.join(self.test_dir, "owned.txt")
        with open(owned_file, "w") as f:
            f.write("isolated update\n")

        # 3. Mock git push failure
        orig_run = subprocess.run

        def mock_run(cmd, *args, **kwargs):
            if isinstance(cmd, list) and len(cmd) >= 2 and cmd[0] == "git" and cmd[1] == "push":
                return subprocess.CompletedProcess(
                    args=cmd,
                    returncode=1,
                    stdout="",
                    stderr="To remote\n ! [rejected] main -> main (non-fast-forward)",
                )
            return orig_run(cmd, *args, **kwargs)

        with patch("agent_branches.sync_git.subprocess.run", side_effect=mock_run):
            res = sync_isolated_owned_paths(self.test_dir, owned_paths=["owned.txt"])

        self.assertEqual(res["status"], "unpushed_checkpoint")
        self.assertFalse(res["verified"])
        self.assertFalse(res["in_sync"])
        self.assertFalse(res["shared_checkout_advanced"])
        self.assertIn("rejected", res["error"])

        # Published commit was created in git object db
        published_sha = res["published_commit"]
        cat_res = subprocess.run(
            ["git", "cat-file", "-t", published_sha],
            cwd=self.test_dir,
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertEqual(cat_res.stdout.strip(), "commit")

        # Durable checkpoint ref must exist and point to published_sha
        checkpoint_ref = res.get("checkpoint_ref")
        self.assertIsNotNone(checkpoint_ref)
        self.assertTrue(checkpoint_ref.startswith("refs/checkpoints/isolated-"))
        ref_sha = subprocess.run(
            ["git", "rev-parse", checkpoint_ref],
            cwd=self.test_dir,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        self.assertEqual(ref_sha, published_sha)
        self.assertIn("restore-", res.get("restore_instructions", ""))

        # Local checkout HEAD remains unchanged
        current_head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.test_dir,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        self.assertEqual(current_head, initial_head)

    def test_sync_isolated_owned_paths_divergent_collision_fail_closed(self):
        # 1. Base commit and push
        base_file = os.path.join(self.test_dir, "owned.txt")
        with open(base_file, "w") as f:
            f.write("base content v0\n")
        subprocess.run(["git", "add", "owned.txt"], cwd=self.test_dir, check=True)
        subprocess.run(["git", "commit", "-m", "initial commit"], cwd=self.test_dir, check=True)
        subprocess.run(["git", "push", "origin", "main"], cwd=self.test_dir, check=True)

        initial_head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.test_dir,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

        # 2. Simulate concurrent remote edit to owned.txt in a clone
        remote_clone = tempfile.mkdtemp()
        try:
            subprocess.run(["git", "clone", self.remote_dir, remote_clone], check=True, capture_output=True)
            subprocess.run(["git", "config", "user.name", "Remote Peer"], cwd=remote_clone, check=True)
            subprocess.run(["git", "config", "user.email", "remote@test.local"], cwd=remote_clone, check=True)
            with open(os.path.join(remote_clone, "owned.txt"), "w") as f:
                f.write("remote concurrent edit v1\n")
            subprocess.run(["git", "commit", "-am", "remote: concurrent edit to owned.txt"], cwd=remote_clone, check=True)
            subprocess.run(["git", "push", "origin", "main"], cwd=remote_clone, check=True)
        finally:
            shutil.rmtree(remote_clone)

        # 3. Local working tree has diverging local edit to owned.txt AND peer dirty file
        with open(base_file, "w") as f:
            f.write("local concurrent edit v1\n")

        peer_dirty = os.path.join(self.test_dir, "peer_dirty.txt")
        with open(peer_dirty, "w") as f:
            f.write("peer uncommitted changes\n")

        # 4. Attempt isolated sync: MUST fail closed with status: conflict
        res = sync_isolated_owned_paths(
            repo_dir=self.test_dir,
            owned_paths=["owned.txt"],
            message="feat: attempt overwriting edit",
        )

        self.assertEqual(res["status"], "conflict")
        self.assertFalse(res["verified"])
        self.assertFalse(res["in_sync"])
        self.assertFalse(res["shared_checkout_advanced"])
        self.assertIn("owned.txt", res["conflicts"])
        self.assertIn("Divergent collision", res["error"])
        self.assertIn("recovery_instructions", res)

        # 5. Local checkout HEAD must be completely untouched
        current_head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.test_dir,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        self.assertEqual(current_head, initial_head)

        # 6. Peer dirty file must remain completely uncommitted and untouched
        status_out = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=self.test_dir,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        self.assertIn("?? peer_dirty.txt", status_out)

        # 7. Remote tip must NOT have been overwritten
        remote_cat = subprocess.run(
            ["git", "show", "origin/main:owned.txt"],
            cwd=self.test_dir,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        self.assertEqual(remote_cat, "remote concurrent edit v1\n")

    def test_cli_sync_git_isolated_mode(self):
        from io import StringIO
        import json
        from agent_branches.cli import main

        # 1. Base commit and push
        base_file = os.path.join(self.test_dir, "base.txt")
        with open(base_file, "w") as f:
            f.write("base content\n")
        subprocess.run(["git", "add", "base.txt"], cwd=self.test_dir, check=True)
        subprocess.run(["git", "commit", "-m", "initial commit"], cwd=self.test_dir, check=True)
        subprocess.run(["git", "push", "origin", "main"], cwd=self.test_dir, check=True)

        # 2. Modify owned file
        owned_file = os.path.join(self.test_dir, "cli_owned.txt")
        with open(owned_file, "w") as f:
            f.write("cli owned content\n")

        # 3. Call CLI via main()
        with patch("sys.stdout", new_callable=StringIO) as mock_out:
            rc = main([
                "sync",
                "git",
                "--repo-dir",
                self.test_dir,
                "--owned-path",
                "cli_owned.txt",
                "--json",
            ])
            self.assertEqual(rc, 0)
            output = mock_out.getvalue()
            res = json.loads(output)
            self.assertEqual(res["status"], "synced")
            self.assertTrue(res["verified"])
            self.assertFalse(res["shared_checkout_advanced"])
            self.assertIn("cli_owned.txt", res["owned_paths"])

    def test_sync_isolated_owned_paths_preview_mode_does_not_commit_or_push(self):
        # 1. Base commit and push
        base_file = os.path.join(self.test_dir, "base.txt")
        with open(base_file, "w") as f:
            f.write("base content\n")
        subprocess.run(["git", "add", "base.txt"], cwd=self.test_dir, check=True)
        subprocess.run(["git", "commit", "-m", "initial commit"], cwd=self.test_dir, check=True)
        subprocess.run(["git", "push", "origin", "main"], cwd=self.test_dir, check=True)

        initial_head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.test_dir,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

        remote_before = get_remote_sha(self.test_dir, "origin", "main")
        self.assertEqual(remote_before, initial_head)

        # 2. Modify owned file AND create peer dirty file in working tree
        owned_file = os.path.join(self.test_dir, "owned_preview.txt")
        with open(owned_file, "w") as f:
            f.write("preview content\n")

        peer_dirty = os.path.join(self.test_dir, "peer_dirty.txt")
        with open(peer_dirty, "w") as f:
            f.write("peer dirty content\n")

        # 3. Call sync_isolated_owned_paths in PREVIEW mode
        res = sync_isolated_owned_paths(
            repo_dir=self.test_dir,
            owned_paths=["owned_preview.txt"],
            message="feat: preview test",
            preview=True,
        )

        self.assertEqual(res["status"], "preview")
        self.assertFalse(res["shared_checkout_advanced"])
        self.assertFalse(res["in_sync"])
        self.assertTrue(res["verified"])
        self.assertIn("owned_preview.txt", res["owned_paths"])
        self.assertIn("Preview mode", res["message"])

        # 4. Verify local checkout HEAD is completely unchanged
        current_head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.test_dir,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        self.assertEqual(current_head, initial_head)

        # 5. Verify peer dirty file is completely untouched
        status_out = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=self.test_dir,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        self.assertIn("?? peer_dirty.txt", status_out)

        # 6. Verify remote tip was NOT changed
        remote_after = get_remote_sha(self.test_dir, "origin", "main")
        self.assertEqual(remote_after, remote_before)

        # 7. Verify NO checkpoint refs were created
        refs_out = subprocess.run(
            ["git", "for-each-ref", "refs/checkpoints/"],
            cwd=self.test_dir,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        self.assertEqual(refs_out, "")

    def test_cli_sync_git_isolated_preview_mode(self):
        from io import StringIO
        import json
        from agent_branches.cli import main

        # 1. Base commit and push
        base_file = os.path.join(self.test_dir, "base.txt")
        with open(base_file, "w") as f:
            f.write("base content\n")
        subprocess.run(["git", "add", "base.txt"], cwd=self.test_dir, check=True)
        subprocess.run(["git", "commit", "-m", "initial commit"], cwd=self.test_dir, check=True)
        subprocess.run(["git", "push", "origin", "main"], cwd=self.test_dir, check=True)

        remote_before = get_remote_sha(self.test_dir, "origin", "main")

        # 2. Modify owned file
        owned_file = os.path.join(self.test_dir, "cli_preview_doc.txt")
        with open(owned_file, "w") as f:
            f.write("cli preview doc content\n")

        # 3. Call CLI in preview mode
        with patch("sys.stdout", new_callable=StringIO) as mock_out:
            rc = main([
                "sync",
                "git",
                "--repo-dir",
                self.test_dir,
                "--owned-path",
                "cli_preview_doc.txt",
                "--preview",
                "--json",
            ])
            self.assertEqual(rc, 0)
            res = json.loads(mock_out.getvalue())
            self.assertEqual(res["status"], "preview")
            self.assertFalse(res["shared_checkout_advanced"])

        # Remote tip must be untouched after preview
        remote_after = get_remote_sha(self.test_dir, "origin", "main")
        self.assertEqual(remote_after, remote_before)

        # 4. Now call CLI in non-preview mode: must push and advance remote
        with patch("sys.stdout", new_callable=StringIO) as mock_out:
            rc = main([
                "sync",
                "git",
                "--repo-dir",
                self.test_dir,
                "--owned-path",
                "cli_preview_doc.txt",
                "--json",
            ])
            self.assertEqual(rc, 0)
            res = json.loads(mock_out.getvalue())
            self.assertEqual(res["status"], "synced")
            self.assertTrue(res["verified"])

        # Remote tip must now be updated to the published commit
        remote_synced = get_remote_sha(self.test_dir, "origin", "main")
        self.assertEqual(remote_synced, res["published_commit"])
        self.assertNotEqual(remote_synced, remote_before)


if __name__ == "__main__":
    unittest.main()


