"""Git integration utilities for agent-branches client."""

import subprocess
from typing import List, Optional


def run_git_cmd(
    args: List[str], cwd: Optional[str] = None, timeout: float = 10.0
) -> Optional[str]:
    """Run a git command safely and return stripped stdout or None on error or timeout."""
    try:
        res = subprocess.run(
            ["git"] + args,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            timeout=timeout,
        )
        if res.returncode == 0:
            return res.stdout.strip()
        return None
    except Exception:
        return None


def get_current_head_sha(cwd: Optional[str] = None, timeout: float = 10.0) -> Optional[str]:
    """Return current HEAD commit SHA or None."""
    return run_git_cmd(["rev-parse", "HEAD"], cwd=cwd, timeout=timeout)


def get_current_branch(cwd: Optional[str] = None, timeout: float = 10.0) -> Optional[str]:
    """Return current branch name or None."""
    branch = run_git_cmd(["branch", "--show-current"], cwd=cwd, timeout=timeout)
    if branch:
        return branch
    return run_git_cmd(["rev-parse", "--abbrev-ref", "HEAD"], cwd=cwd, timeout=timeout)


def get_remote_url(
    remote: str = "origin", cwd: Optional[str] = None, timeout: float = 10.0
) -> Optional[str]:
    """Return URL of given git remote or None."""
    return run_git_cmd(["remote", "get-url", remote], cwd=cwd, timeout=timeout)


def get_changed_files(
    base_sha: Optional[str] = None,
    head_sha: Optional[str] = None,
    cwd: Optional[str] = None,
    timeout: float = 10.0,
) -> Optional[List[str]]:
    """Return list of changed file paths between base_sha and head_sha using NUL-separated (-z) diff.

    Returns:
        List[str] on success (empty list if zero files changed),
        or None if git diff fails, times out, or raises an error (never masks error as empty list).
    """
    if not head_sha:
        head_sha = "HEAD"

    diff_args = ["diff", "-z", "--name-only"]
    if base_sha:
        diff_args.append(f"{base_sha}...{head_sha}")
    else:
        diff_args.extend([f"{head_sha}~1", head_sha])

    try:
        res = subprocess.run(
            ["git"] + diff_args,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=timeout,
        )
        # If symmetric difference failed (e.g. invalid base_sha or shallow repo), try two-dot diff
        if res.returncode != 0 and base_sha:
            fallback_args = ["git", "diff", "-z", "--name-only", base_sha, head_sha]
            res = subprocess.run(
                fallback_args,
                cwd=cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=timeout,
            )

        if res.returncode != 0:
            return None

        # Parse NUL-separated byte stream
        raw = res.stdout
        if not raw:
            return []

        entries = raw.split(b"\0")
        files = [
            entry.decode("utf-8", errors="replace")
            for entry in entries
            if entry
        ]
        return files
    except Exception:
        return None
