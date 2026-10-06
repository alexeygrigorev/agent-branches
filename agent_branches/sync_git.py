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
    ".dev.vars",
    ".dev.vars.",
    "id_",
    ".pem",
    ".key",
    "credentials",
    "token",
    "secret",
    "secrets",
    "api_key",
    "service_account",
    "service-account",
    "client_secret",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".local/",
    ".secrets/",
    ".credentials/",
    ".ssh/",
    ".aws/",
    ".wrangler/",
    "__pycache__/",
    ".pytest_cache/",
    "node_modules/",
]

DOC_TEMPLATE_WHITELIST = {
    ".env.example",
    ".env.template",
    ".env.sample",
}

INFIX_SECRET_TOKENS = (
    "_token.",
    "-token.",
    "_key.",
    "-key.",
    "_secret.",
    "-secret.",
)

SENSITIVE_DIRS = {
    ".secrets",
    ".credentials",
    ".ssh",
    ".aws",
    ".wrangler",
    ".local",
    "__pycache__",
    ".pytest_cache",
    "node_modules",
}

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
    path_obj = Path(p_str)

    # 1. Directory check: verify if any directory component matches sensitive directories
    sensitive_dirs = {pat.rstrip("/") for pat in FORBIDDEN_PATTERNS if pat.endswith("/")}
    sensitive_dirs.update(SENSITIVE_DIRS)
    if any(part in sensitive_dirs for part in path_obj.parts):
        return True
    for pat in FORBIDDEN_PATTERNS:
        if pat.endswith("/") and (pat in p_str or p_str.startswith(pat)):
            return True

    name = path_obj.name

    # 2. Documentation template whitelist (must return False)
    if name in DOC_TEMPLATE_WHITELIST:
        return False

    # 3. Infix delimiter match for secret tokens
    if any(infix in name for infix in INFIX_SECRET_TOKENS):
        return True

    # 4. Filename pattern checks
    for pat in FORBIDDEN_PATTERNS:
        if pat.endswith("/"):
            continue
        if pat == "id_":
            if name.startswith("id_"):
                return True
        elif pat.startswith("."):
            if pat.endswith("."):
                if name.startswith(pat):
                    return True
            else:
                if name == pat or name.startswith(pat + ".") or name.endswith(pat):
                    return True
        else:
            if (
                name == pat
                or name.startswith(pat + ".")
                or name.endswith("." + pat)
            ):
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
    try:
        res = subprocess.run(
            ["git", "diff", "--cached", "--name-only", "-z"],
            cwd=repo_dir,
            capture_output=True,
            timeout=SUBPROCESS_TIMEOUT_SEC,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise SyncGitError(f"git diff --cached timed out after {exc.timeout}s")
    if res.returncode != 0:
        raise SyncGitError(f"git diff --cached failed: {res.stderr.decode(errors='replace')}")
    raw = res.stdout
    if not raw:
        return []
    return [p for p in raw.decode("utf-8", errors="replace").split("\0") if p]


def get_status_entries(repo_dir: str) -> Tuple[List[str], List[str], List[str]]:
    """Return lists of (modified_tracked, untracked_safe, untracked_forbidden) via NUL-delimited status."""
    try:
        res = subprocess.run(
            ["git", "status", "--porcelain=v1", "-z", "-uall"],
            cwd=repo_dir,
            capture_output=True,
            timeout=SUBPROCESS_TIMEOUT_SEC,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise SyncGitError(f"git status timed out after {exc.timeout}s")
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
            if (
                ext in SAFE_SOURCE_EXTENSIONS
                or Path(path_str).name in {"Dockerfile", "Makefile", "LICENSE"}
                or Path(path_str).name in DOC_TEMPLATE_WHITELIST
            ):
                untracked_safe.append(path_str)
        else:
            modified.append(path_str)
        i += 1

    return modified, untracked_safe, untracked_forbidden


def get_current_branch(repo_dir: str) -> str:
    try:
        res = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT_SEC,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise SyncGitError(f"git branch timed out after {exc.timeout}s")
    branch = res.stdout.strip()
    if not branch:
        try:
            res2 = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=repo_dir,
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT_SEC,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise SyncGitError(f"git rev-parse timed out after {exc.timeout}s")
        branch = res2.stdout.strip()
    if not branch or branch == "HEAD":
        raise SyncGitError("Cannot sync detached HEAD; must be on a named branch.")
    return branch


def get_remote_sha(repo_dir: str, remote: str, branch: str) -> Optional[str]:
    try:
        res = subprocess.run(
            ["git", "ls-remote", remote, f"refs/heads/{branch}"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT_SEC,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return None
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
            try:
                head_sha = subprocess.run(
                    ["git", "rev-parse", "HEAD"],
                    cwd=str(repo_path),
                    capture_output=True,
                    text=True,
                    timeout=SUBPROCESS_TIMEOUT_SEC,
                    check=True,
                ).stdout.strip()
            except subprocess.TimeoutExpired as exc:
                raise SyncGitError(f"git rev-parse HEAD timed out after {exc.timeout}s")
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
            try:
                res_push = subprocess.run(
                    ["git", "push", remote, branch],
                    cwd=str(repo_path),
                    capture_output=True,
                    text=True,
                    timeout=PUSH_TIMEOUT_SEC,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                return {
                    "status": "unpushed_checkpoint",
                    "branch": branch,
                    "head_sha": head_sha,
                    "remote_sha": rem_sha,
                    "verified": False,
                    "in_sync": False,
                    "error": f"git push timed out after {exc.timeout}s",
                    "message": "Clean working tree ahead of remote, but git push timed out.",
                }
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
        try:
            res_add = subprocess.run(
                stage_cmd,
                cwd=str(repo_path),
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT_SEC,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise SyncGitError(f"git add timed out after {exc.timeout}s")
        if res_add.returncode != 0:
            raise SyncGitError(f"git add failed: {res_add.stderr.strip()}")

        # 6. Commit checkpoint
        commit_msg = message or f"WIP: agent sync checkpoint at {datetime.now(timezone.utc).isoformat()}"
        try:
            res_commit = subprocess.run(
                ["git", "commit", "-m", commit_msg],
                cwd=str(repo_path),
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT_SEC,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise SyncGitError(f"git commit timed out after {exc.timeout}s")
        if res_commit.returncode != 0:
            raise SyncGitError(f"git commit failed: {res_commit.stderr.strip()}")

        try:
            head_sha = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=str(repo_path),
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT_SEC,
                check=True,
            ).stdout.strip()
        except subprocess.TimeoutExpired as exc:
            raise SyncGitError(f"git rev-parse HEAD timed out after {exc.timeout}s")

        # 7. Non-force push
        try:
            res_push = subprocess.run(
                ["git", "push", remote, branch],
                cwd=str(repo_path),
                capture_output=True,
                text=True,
                timeout=PUSH_TIMEOUT_SEC,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            return {
                "status": "unpushed_checkpoint",
                "branch": branch,
                "head_sha": head_sha,
                "remote_sha": None,
                "verified": False,
                "in_sync": False,
                "error": f"git push timed out after {exc.timeout}s",
                "message": "Checkpoint committed locally, but git push timed out. Local commit preserved for retry.",
                "commit_message": commit_msg,
                "staged_files": to_stage,
                "ignored_forbidden": untracked_forbidden,
            }
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
