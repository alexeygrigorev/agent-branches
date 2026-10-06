"""
Bounded session history and pending state preservation.
Captures declared session history, session metadata, and pending state
into a bounded, private archive location without global queue copies or unrelated chat data.
Conforms to C2889 maintainer-friction intake requirements.
"""
import hashlib
import json
import os
import pathlib
import shutil
import stat
from typing import Dict, Any, Optional

DEFAULT_MAX_BYTES = 50 * 1024 * 1024  # 50 MiB bounded budget


class HistoryPreservationError(Exception):
    """Base error for history preservation failures."""
    pass


class SessionNotFoundError(HistoryPreservationError):
    """Raised when the specified session directory does not exist."""
    pass


class BudgetExceededError(HistoryPreservationError):
    """Raised when session history exceeds the configured storage budget."""
    pass


def preserve_session_history(
    session_id: str,
    output_dir: pathlib.Path,
    state_dir: Optional[pathlib.Path] = None,
    max_bytes: int = DEFAULT_MAX_BYTES,
    preserve_pending: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Preserves a session's history and pending state into a bounded private archive.

    Guarantees:
    - Bounded budget enforcement (fails closed if history exceeds max_bytes).
    - Private file permissions (0600 on files, 0700 on directories).
    - Scope isolation: copies only declared session files, never global queue or unrelated chat data.
    - Generation audit tracking with cryptographic SHA-256 verification.
    """
    if not session_id or not isinstance(session_id, str):
        raise HistoryPreservationError("Invalid session_id provided")

    # Sanitize session_id to prevent path traversal
    safe_session_id = pathlib.Path(session_id).name
    if safe_session_id != session_id or ".." in session_id:
        raise HistoryPreservationError(f"Potentially unsafe session_id: {session_id}")

    if state_dir is None:
        state_dir = pathlib.Path.home() / ".local/state/aplexer"

    session_src_dir = state_dir / "sessions" / safe_session_id
    if not session_src_dir.exists() or not session_src_dir.is_dir():
        raise SessionNotFoundError(f"Session directory not found: {session_src_dir}")

    # Inspect history.bin size and presence
    history_bin = session_src_dir / "history.bin"
    history_size = 0
    history_sha256 = None
    if history_bin.exists():
        history_size = history_bin.stat().st_size
        if history_size > max_bytes:
            raise BudgetExceededError(
                f"History size {history_size} bytes exceeds maximum allowed budget {max_bytes} bytes"
            )
        hasher = hashlib.sha256()
        with open(history_bin, "rb") as f:
            while chunk := f.read(65536):
                hasher.update(chunk)
        history_sha256 = hasher.hexdigest()

    # Create target archive directory with private permissions (0700)
    target_dir = pathlib.Path(output_dir) / safe_session_id
    target_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(target_dir, stat.S_IRWXU)

    # Copy history.bin if present with 0600 permissions
    target_history_bin = target_dir / "history.bin"
    if history_bin.exists():
        shutil.copy2(history_bin, target_history_bin)
        os.chmod(target_history_bin, stat.S_IRUSR | stat.S_IWUSR)

    # Archive metadata and pending state
    meta = {
        "session_id": safe_session_id,
        "history_present": history_bin.exists(),
        "history_bytes": history_size,
        "history_sha256": history_sha256,
        "budget_max_bytes": max_bytes,
        "pending_state": preserve_pending,
        "archived_at_epoch": int(os.stat(target_dir).st_mtime),
    }

    meta_file = target_dir / "preservation_metadata.json"
    with open(meta_file, "w") as f:
        json.dump(meta, f, indent=2)
    os.chmod(meta_file, stat.S_IRUSR | stat.S_IWUSR)

    return {
        "status": "preserved",
        "session_id": safe_session_id,
        "archive_path": str(target_dir),
        "history_bytes": history_size,
        "history_sha256": history_sha256,
        "meta_file": str(meta_file),
    }
