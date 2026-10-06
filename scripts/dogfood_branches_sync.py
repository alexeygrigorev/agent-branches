#!/usr/bin/env python3
"""
Dogfood Automated Branches Sync Git Pipeline.
Executes isolated owned-path preview, push, and remote recovery verification
without touching the local shared checkout HEAD, shared .git/index, or dirty peer files.
Conforms to C2888 principal requirements.
"""
import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import uuid

# Ensure agent-branches and agent-bus modules are importable
ROOT_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from agent_branches.sync_git import sync_isolated_owned_paths


def run_cmd(cmd, cwd=None, env=None):
    res = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"Command failed (exit {res.returncode}): {' '.join(cmd)}\nStderr: {res.stderr}\nStdout: {res.stdout}")
    return res.stdout.strip()


def run_dogfood_pipeline(repo_dir: str = None, remote_url: str = None, branch_name: str = None):
    pipeline_id = str(uuid.uuid4())[:8]
    if branch_name is None:
        branch_name = f"dogfood-test-{pipeline_id}"

    results = {
        "pipeline_id": pipeline_id,
        "branch_name": branch_name,
        "stages": {},
        "success": False
    }

    with tempfile.TemporaryDirectory(prefix="branches-dogfood-") as temp_dir:
        temp_path = pathlib.Path(temp_dir)
        upstream_repo = temp_path / "upstream.git"
        local_worktree = temp_path / "worktree"
        recovery_clone = temp_path / "recovery"

        # 1. Initialize bare upstream repository
        run_cmd(["git", "init", "--bare", str(upstream_repo)])

        # 2. Initialize local worktree with initial commit on main
        run_cmd(["git", "init", str(local_worktree)])
        run_cmd(["git", "config", "user.email", "dogfood@antigravity.test"], cwd=local_worktree)
        run_cmd(["git", "config", "user.name", "Antigravity Dogfood"], cwd=local_worktree)

        initial_file = local_worktree / "README.md"
        initial_file.write_text("# Dogfood Test Repo\n")
        run_cmd(["git", "add", "README.md"], cwd=local_worktree)
        run_cmd(["git", "commit", "-m", "chore: initial commit"], cwd=local_worktree)
        initial_head_sha = run_cmd(["git", "rev-parse", "HEAD"], cwd=local_worktree)

        run_cmd(["git", "remote", "add", "origin", str(upstream_repo)], cwd=local_worktree)
        run_cmd(["git", "push", "-u", "origin", "main"], cwd=local_worktree)

        # 3. Simulate peer dirty uncommitted file and owned feature file
        peer_dirty_file = local_worktree / "peer_work.txt"
        peer_dirty_file.write_text("Uncommitted peer work that must not be touched or leaked\n")

        owned_feature_file = local_worktree / "feature.py"
        feature_content = f"# Feature implemented by dogfood pipeline {pipeline_id}\ndef hello():\n    return '{pipeline_id}'\n"
        owned_feature_file.write_text(feature_content)
        expected_sha256 = hashlib.sha256(feature_content.encode()).hexdigest()

        # Stage 1: Preview Mode
        preview_res = sync_isolated_owned_paths(
            repo_dir=str(local_worktree),
            owned_paths=["feature.py"],
            remote="origin",
            branch=branch_name,
            preview=True
        )
        assert preview_res.get("status") == "preview", f"Expected preview status, got {preview_res}"
        
        # Verify remote branch does NOT exist yet
        remote_refs = run_cmd(["git", "ls-remote", str(upstream_repo), branch_name])
        assert not remote_refs, f"Remote branch {branch_name} should not exist after preview"
        
        # Verify local HEAD is unchanged
        current_head = run_cmd(["git", "rev-parse", "HEAD"], cwd=local_worktree)
        assert current_head == initial_head_sha, "Local HEAD was modified during preview!"
        results["stages"]["preview"] = {"status": "PASSED", "details": preview_res}

        # Stage 2: Real Isolated Apply & Push
        sync_res = sync_isolated_owned_paths(
            repo_dir=str(local_worktree),
            owned_paths=["feature.py"],
            remote="origin",
            branch=branch_name,
            message=f"feat(dogfood): add feature {pipeline_id}"
        )
        assert sync_res.get("status") == "synced", f"Expected synced status, got {sync_res}"
        pushed_sha = sync_res.get("published_commit")
        
        # Verify remote branch exists and matches pushed SHA
        remote_tip = run_cmd(["git", "rev-parse", f"refs/heads/{branch_name}"], cwd=upstream_repo)
        assert remote_tip == pushed_sha, f"Remote tip {remote_tip} does not match pushed commit {pushed_sha}"

        # Verify local checkout HEAD is STILL unchanged
        current_head_after_push = run_cmd(["git", "rev-parse", "HEAD"], cwd=local_worktree)
        assert current_head_after_push == initial_head_sha, "Local HEAD was advanced during push!"

        # Verify peer dirty file is completely preserved
        assert peer_dirty_file.read_text() == "Uncommitted peer work that must not be touched or leaked\n"
        results["stages"]["isolated_push"] = {"status": "PASSED", "commit": pushed_sha}

        # Stage 3: Real Independent Git Recovery & Verification
        run_cmd(["git", "clone", "--branch", branch_name, str(upstream_repo), str(recovery_clone)])
        recovered_feature_file = recovery_clone / "feature.py"
        assert recovered_feature_file.exists(), "Recovered feature file missing in clone!"
        recovered_content = recovered_feature_file.read_text()
        recovered_sha256 = hashlib.sha256(recovered_content.encode()).hexdigest()
        assert recovered_sha256 == expected_sha256, f"Checksum mismatch: {recovered_sha256} != {expected_sha256}"

        # Verify peer dirty file was NEVER pushed or leaked into remote branch
        assert not (recovery_clone / "peer_work.txt").exists(), "Peer dirty file leaked into remote branch!"
        results["stages"]["remote_recovery"] = {
            "status": "PASSED",
            "recovered_sha256": recovered_sha256,
            "leakage_clean": True
        }

        results["success"] = True
        return results


def main():
    parser = argparse.ArgumentParser(description="Dogfood Branches Sync Git Pipeline")
    parser.add_argument("--json", action="store_true", help="Output JSON format")
    args = parser.parse_args()

    try:
        res = run_dogfood_pipeline()
        if args.json:
            print(json.dumps(res, indent=2))
        else:
            print(f"Dogfood Pipeline {res['pipeline_id']} Succeeded!")
            print(f"Pushed Commit: {res['stages']['isolated_push']['commit']}")
            print(f"Recovered SHA256: {res['stages']['remote_recovery']['recovered_sha256']}")
        sys.exit(0)
    except Exception as e:
        if args.json:
            print(json.dumps({"error": str(e), "success": False}, indent=2))
        else:
            print(f"Error executing dogfood pipeline: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
