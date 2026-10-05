"""One-command sanitized checkpoint and GitHub synchronization for agent-branches.

Implements `branches sync git`:
- Scoped change preview.
- Intended tracked and untracked source handling.
- Strict secret and private file (.local, .env, credentials) protection.
- Ordinary non-force git push.
- Verifiable remote SHA check via ls-remote.
- Truthful exit status and structured receipt.
"""

from datetime import datetime, timezone
import os
from pathlib import Path
import subprocess
from typing import Any, Dict, List, Optional, Tuple

FORBIDDEN_PATTERNS = [
    ".env",
    "id_rsa",
    "id_ed25519",
    ".pem",
    ".key",
    "credentials",
    "token",
    ".local/",
    "__pycache__/",
    ".pytest_cache/",
    "node_modules/",
]

SAFE_SOURCE_EXTENSIONS = {
    ".py", ".ts", ".js", ".json", ".md", ".toml", ".yaml", ".yml",
    ".sh", ".html", ".css", ".txt", ".sql", ".rs", ".go"
}


class SyncGitError(Exception):
    """Base exception for sync git failures."""
    pass


class SecretLeakageError(SyncGitError):
    """Raised when an attempt is made to commit private files or credentials."""
    pass


def is_forbidden(rel_path: str) -> bool:
    """Check if relative path matches forbidden secret or local storage patterns."""
    p_str = rel_path.replace("\\", "/")
    for pat in FORBIDDEN_PATTERNS:
        if pat.endswith("/"):
            if pat in p_str or p_str.startswith(pat):
                return True
        else:
            name = Path(p_str).name
            if pat in name or p_str.endswith(pat):
                return True
    return False


def get_status_entries(repo_dir: str) -> Tuple[List[str], List[str], List[str]]:
    """Return lists of (modified_tracked, untracked_safe, untracked_forbidden)."""
    res = subprocess.run(
        ["git", "status", "--porcelain=v1", "-uall"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        check=False,
    )
    if res.returncode != 0:
        raise SyncGitError(f"git status failed: {res.stderr.strip()}")

    modified = []
    untracked_safe = []
    untracked_forbidden = []

    for line in res.stdout.splitlines():
        if not line or len(line) < 4:
            continue
        status_code = line[:2]
        path_str = line[3:].strip()
        if " -> " in path_str:
            path_str = path_str.split(" -> ")[1].strip()

        if is_forbidden(path_str):
            untracked_forbidden.append(path_str)
            continue

        if status_code.startswith("?") or status_code.endswith("?"):
            ext = Path(path_str).suffix.lower()
            if ext in SAFE_SOURCE_EXTENSIONS or Path(path_str).name in {"Dockerfile", "Makefile", "LICENSE"}:
                untracked_safe.append(path_str)
        else:
            modified.append(path_str)

    return modified, untracked_safe, untracked_forbidden


def get_current_branch(repo_dir: str) -> str:
    res = subprocess.run(
        ["git", "branch", "--show-current"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        check=False,
    )
    branch = res.stdout.strip()
    if not branch:
        res2 = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            check=False,
        )
        branch = res2.stdout.strip()
    if not branch or branch == "HEAD":
        raise SyncGitError("Cannot sync detached HEAD; must be on a named branch.")
    return branch


def get_remote_sha(repo_dir: str, remote: str, branch: str) -> Optional[str]:
    res = subprocess.run(
        ["git", "ls-remote", remote, f"refs/heads/{branch}"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        check=False,
    )
    if res.returncode == 0 and res.stdout.strip():
        parts = res.stdout.strip().split()
        if parts:
            return parts[0]
    return None


def sync_git(
    repo_dir: str,
    message: Optional[str] = None,
    preview: bool = False,
    remote: str = "origin",
) -> Dict[str, Any]:
    """Execute sanitized checkpoint and push with remote SHA verification."""
    repo_path = Path(repo_dir).resolve()
    if not (repo_path / ".git").exists():
        raise SyncGitError(f"Not a git repository: {repo_path}")

    branch = get_current_branch(str(repo_path))
    modified, untracked_safe, untracked_forbidden = get_status_entries(str(repo_path))

    to_stage = modified + untracked_safe

    if preview:
        return {
            "status": "preview",
            "branch": branch,
            "modified_tracked": modified,
            "untracked_safe_to_add": untracked_safe,
            "forbidden_ignored": untracked_forbidden,
            "to_stage_count": len(to_stage),
        }

    # Verify no staged forbidden files
    for f in to_stage:
        if is_forbidden(f):
            raise SecretLeakageError(f"Refusing to sync forbidden/sensitive path: {f}")

    if not to_stage:
        # Working tree clean; check remote status
        head_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(repo_path),
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        rem_sha = get_remote_sha(str(repo_path), remote, branch)
        return {
            "status": "noop",
            "message": "Working tree clean, nothing to commit",
            "branch": branch,
            "head_sha": head_sha,
            "remote_sha": rem_sha,
            "in_sync": (head_sha == rem_sha) if rem_sha else True,
        }

    # Stage files
    stage_cmd = ["git", "add", "--"] + to_stage
    res_add = subprocess.run(stage_cmd, cwd=str(repo_path), capture_output=True, text=True)
    if res_add.returncode != 0:
        raise SyncGitError(f"git add failed: {res_add.stderr.strip()}")

    # Commit
    commit_msg = message or f"WIP: agent sync checkpoint at {datetime.now(timezone.utc).isoformat()}"
    res_commit = subprocess.run(
        ["git", "commit", "-m", commit_msg],
        cwd=str(repo_path),
        capture_output=True,
        text=True,
    )
    if res_commit.returncode != 0:
        raise SyncGitError(f"git commit failed: {res_commit.stderr.strip()}")

    head_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=str(repo_path),
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()

    # Non-force push
    res_push = subprocess.run(
        ["git", "push", remote, branch],
        cwd=str(repo_path),
        capture_output=True,
        text=True,
    )
    if res_push.returncode != 0:
        # Rollback local commit to leave working tree dirty as before
        subprocess.run(["git", "reset", "HEAD~1"], cwd=str(repo_path), capture_output=True)
        raise SyncGitError(f"git push failed (rolled back commit): {res_push.stderr.strip()}")

    # Verify remote SHA
    rem_sha = get_remote_sha(str(repo_path), remote, branch)
    verified = (rem_sha == head_sha)

    return {
        "status": "synced",
        "branch": branch,
        "head_sha": head_sha,
        "remote_sha": rem_sha,
        "verified": verified,
        "commit_message": commit_msg,
        "staged_files": to_stage,
        "ignored_forbidden": untracked_forbidden,
    }
