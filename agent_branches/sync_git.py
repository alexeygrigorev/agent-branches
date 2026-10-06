"""One-command sanitized checkpoint and GitHub synchronization for agent-branches.

Implements `branches sync git`:
- Scoped change preview.
- Intended tracked and untracked source handling.
- Strict secret and private file (.local, .env, credentials) protection.
- Pre-existing staged secret scan via `git diff --cached --name-only -z`.
- Robust porcelain status parsing with `-z -uall` (NUL-delimited).
- Safe checkpoint commit preserved on push failure (never resets or rolls back).
- Clean-ahead push with remote query error fail-closed.
- Verifiable remote SHA check via ls-remote; explicit push_unverified on mismatch.
- Exclusive repository lock with bounded timeout.
- Truthful exit status and structured receipt.
"""

from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import os
from pathlib import Path
import subprocess
import time
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

SUBPROCESS_TIMEOUT_SEC = 30.0
PUSH_TIMEOUT_SEC = 60.0


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
            if pat.startswith("."):
                if name == pat or name.startswith(pat + ".") or name.endswith(pat):
                    return True
            else:
                if name == pat or name.startswith(pat + ".") or name.endswith("." + pat):
                    return True
    return False


@contextmanager
def repo_lock(repo_dir: str, timeout_sec: float = 10.0):
    """Acquire exclusive flock on .local/git.lock to serialize concurrent syncs."""
    lock_dir = Path(repo_dir) / ".local"
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_file = lock_dir / "git.lock"
    fd = os.open(str(lock_file), os.O_CREAT | os.O_RDWR, 0o644)
    start_time = time.monotonic()
    acquired = False
    try:
        while time.monotonic() - start_time < timeout_sec:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except (IOError, OSError):
                time.sleep(0.05)
        if not acquired:
            raise SyncGitError(f"Could not acquire repository lock at {lock_file} within {timeout_sec}s")
        yield
    finally:
        if acquired:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except Exception:
                pass
        os.close(fd)


def get_staged_entries(repo_dir: str) -> List[str]:
    """Inspect index via `git diff --cached --name-only -z` to catch pre-staged secrets."""
    res = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "-z"],
        cwd=repo_dir,
        capture_output=True,
        timeout=SUBPROCESS_TIMEOUT_SEC,
        check=False,
    )
    if res.returncode != 0:
        raise SyncGitError(f"git diff --cached failed: {res.stderr.decode(errors='replace')}")
    raw = res.stdout
    if not raw:
        return []
    return [p for p in raw.decode("utf-8", errors="replace").split("\0") if p]


def get_status_entries(repo_dir: str) -> Tuple[List[str], List[str], List[str]]:
    """Return lists of (modified_tracked, untracked_safe, untracked_forbidden) via NUL-delimited status."""
    res = subprocess.run(
        ["git", "status", "--porcelain=v1", "-z", "-uall"],
        cwd=repo_dir,
        capture_output=True,
        timeout=SUBPROCESS_TIMEOUT_SEC,
        check=False,
    )
    if res.returncode != 0:
        raise SyncGitError(f"git status failed: {res.stderr.decode(errors='replace')}")

    modified = []
    untracked_safe = []
    untracked_forbidden = []

    raw = res.stdout
    if not raw:
        return modified, untracked_safe, untracked_forbidden

    parts = raw.split(b"\0")
    i = 0
    while i < len(parts):
        item = parts[i]
        if not item:
            i += 1
            continue
        if len(item) < 3:
            i += 1
            continue
        status_code = item[:2].decode("latin1", errors="replace")
        path_str = item[3:].decode("utf-8", errors="replace")

        # In porcelain -z, rename or copy records have the original path in the next entry
        if "R" in status_code or "C" in status_code:
            i += 1

        if is_forbidden(path_str):
            untracked_forbidden.append(path_str)
        elif status_code.startswith("?") or status_code.endswith("?"):
            ext = Path(path_str).suffix.lower()
            if ext in SAFE_SOURCE_EXTENSIONS or Path(path_str).name in {"Dockerfile", "Makefile", "LICENSE"}:
                untracked_safe.append(path_str)
        else:
            modified.append(path_str)
        i += 1

    return modified, untracked_safe, untracked_forbidden


def get_current_branch(repo_dir: str) -> str:
    res = subprocess.run(
        ["git", "branch", "--show-current"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=SUBPROCESS_TIMEOUT_SEC,
        check=False,
    )
    branch = res.stdout.strip()
    if not branch:
        res2 = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT_SEC,
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
        timeout=SUBPROCESS_TIMEOUT_SEC,
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

    with repo_lock(str(repo_path)):
        branch = get_current_branch(str(repo_path))

        # 1. Pre-existing staged secret scan
        already_staged = get_staged_entries(str(repo_path))
        staged_secrets = [f for f in already_staged if is_forbidden(f)]
        if staged_secrets:
            raise SecretLeakageError(
                f"Index already contains staged forbidden file(s): {staged_secrets}. Refusing to proceed."
            )

        # 2. Get working tree status
        modified, untracked_safe, untracked_forbidden = get_status_entries(str(repo_path))
        to_stage = modified + untracked_safe

        if preview:
            return {
                "status": "preview",
                "branch": branch,
                "modified_tracked": modified,
                "untracked_safe_to_add": untracked_safe,
                "forbidden_ignored": untracked_forbidden,
                "ignored_forbidden": untracked_forbidden,
                "to_stage_count": len(to_stage),
            }

        # 3. Guard against forbidden paths in candidate list
        for f in to_stage:
            if is_forbidden(f):
                raise SecretLeakageError(f"Refusing to sync forbidden/sensitive path: {f}")

        # 4. Handle clean working tree (clean-ahead check)
        if not to_stage:
            head_sha = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=str(repo_path),
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT_SEC,
                check=True,
            ).stdout.strip()
            rem_sha = get_remote_sha(str(repo_path), remote, branch)

            if rem_sha is not None and head_sha == rem_sha:
                return {
                    "status": "noop",
                    "message": "Working tree clean, in sync with remote",
                    "branch": branch,
                    "head_sha": head_sha,
                    "remote_sha": rem_sha,
                    "in_sync": True,
                    "verified": True,
                }

            # Clean working tree is ahead of remote or remote branch absent: attempt push
            res_push = subprocess.run(
                ["git", "push", remote, branch],
                cwd=str(repo_path),
                capture_output=True,
                text=True,
                timeout=PUSH_TIMEOUT_SEC,
                check=False,
            )
            if res_push.returncode != 0:
                return {
                    "status": "unpushed_checkpoint",
                    "branch": branch,
                    "head_sha": head_sha,
                    "remote_sha": rem_sha,
                    "verified": False,
                    "in_sync": False,
                    "error": f"git push failed: {res_push.stderr.strip()}",
                    "message": "Clean working tree ahead of remote, but git push failed.",
                }

            rem_sha_after = get_remote_sha(str(repo_path), remote, branch)
            verified = (rem_sha_after == head_sha)
            return {
                "status": "synced" if verified else "push_unverified",
                "message": "Pushed clean-ahead commits" if verified else "Push completed but remote SHA mismatch",
                "branch": branch,
                "head_sha": head_sha,
                "remote_sha": rem_sha_after,
                "verified": verified,
                "in_sync": verified,
            }

        # 5. Stage files
        stage_cmd = ["git", "add", "--"] + to_stage
        res_add = subprocess.run(
            stage_cmd,
            cwd=str(repo_path),
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT_SEC,
            check=False,
        )
        if res_add.returncode != 0:
            raise SyncGitError(f"git add failed: {res_add.stderr.strip()}")

        # 6. Commit checkpoint
        commit_msg = message or f"WIP: agent sync checkpoint at {datetime.now(timezone.utc).isoformat()}"
        res_commit = subprocess.run(
            ["git", "commit", "-m", commit_msg],
            cwd=str(repo_path),
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT_SEC,
            check=False,
        )
        if res_commit.returncode != 0:
            raise SyncGitError(f"git commit failed: {res_commit.stderr.strip()}")

        head_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(repo_path),
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT_SEC,
            check=True,
        ).stdout.strip()

        # 7. Non-force push
        res_push = subprocess.run(
            ["git", "push", remote, branch],
            cwd=str(repo_path),
            capture_output=True,
            text=True,
            timeout=PUSH_TIMEOUT_SEC,
            check=False,
        )
        if res_push.returncode != 0:
            # PRESERVE local checkpoint commit! Never execute git reset HEAD~1.
            return {
                "status": "unpushed_checkpoint",
                "branch": branch,
                "head_sha": head_sha,
                "remote_sha": None,
                "verified": False,
                "in_sync": False,
                "error": f"git push failed: {res_push.stderr.strip()}",
                "message": "Checkpoint committed locally, but git push failed. Local commit preserved for retry.",
                "commit_message": commit_msg,
                "staged_files": to_stage,
                "ignored_forbidden": untracked_forbidden,
            }

        # 8. Verify remote SHA matches local HEAD
        rem_sha = get_remote_sha(str(repo_path), remote, branch)
        verified = (rem_sha == head_sha)

        if not verified:
            return {
                "status": "push_unverified",
                "branch": branch,
                "head_sha": head_sha,
                "remote_sha": rem_sha,
                "verified": False,
                "in_sync": False,
                "message": f"Push succeeded but remote SHA ({rem_sha}) does not match local HEAD ({head_sha})",
                "commit_message": commit_msg,
                "staged_files": to_stage,
                "ignored_forbidden": untracked_forbidden,
            }

        return {
            "status": "synced",
            "branch": branch,
            "head_sha": head_sha,
            "remote_sha": rem_sha,
            "verified": True,
            "in_sync": True,
            "commit_message": commit_msg,
            "staged_files": to_stage,
            "ignored_forbidden": untracked_forbidden,
        }
