"""
Unit tests for agent_branches.history_preserve.
Verifies bounded history preservation, privacy permissions, and negative edge cases.
"""
import json
import os
import pathlib
import stat
import tempfile
import pytest

from agent_branches.history_preserve import (
    preserve_session_history,
    SessionNotFoundError,
    BudgetExceededError,
    HistoryPreservationError,
)


def test_preserve_session_history_success():
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = pathlib.Path(tmp_dir)
        state_dir = tmp_path / "aplexer"
        output_dir = tmp_path / "archive"

        # Setup mock session
        session_id = "test-session-1234"
        session_dir = state_dir / "sessions" / session_id
        session_dir.mkdir(parents=True)
        history_bin = session_dir / "history.bin"
        history_content = b"Mock terminal history buffer bytes"
        history_bin.write_bytes(history_content)

        pending_state = {"message_id": "msg-001", "task_id": "test-task"}

        res = preserve_session_history(
            session_id=session_id,
            output_dir=output_dir,
            state_dir=state_dir,
            max_bytes=1024 * 1024,
            preserve_pending=pending_state,
        )

        assert res["status"] == "preserved"
        assert res["session_id"] == session_id
        assert res["history_bytes"] == len(history_content)
        assert res["history_sha256"] is not None

        # Verify archive files
        archived_dir = pathlib.Path(res["archive_path"])
        assert archived_dir.exists()
        assert stat.S_IMODE(archived_dir.stat().st_mode) == 0o700

        archived_history = archived_dir / "history.bin"
        assert archived_history.exists()
        assert archived_history.read_bytes() == history_content
        assert stat.S_IMODE(archived_history.stat().st_mode) == 0o600

        archived_meta = archived_dir / "preservation_metadata.json"
        assert archived_meta.exists()
        assert stat.S_IMODE(archived_meta.stat().st_mode) == 0o600
        meta_data = json.loads(archived_meta.read_text())
        assert meta_data["pending_state"] == pending_state


def test_preserve_session_history_session_not_found():
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = pathlib.Path(tmp_dir)
        state_dir = tmp_path / "aplexer"
        output_dir = tmp_path / "archive"

        with pytest.raises(SessionNotFoundError):
            preserve_session_history("nonexistent-session", output_dir, state_dir=state_dir)


def test_preserve_session_history_budget_exceeded():
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = pathlib.Path(tmp_dir)
        state_dir = tmp_path / "aplexer"
        output_dir = tmp_path / "archive"

        session_id = "oversized-session"
        session_dir = state_dir / "sessions" / session_id
        session_dir.mkdir(parents=True)
        history_bin = session_dir / "history.bin"
        history_bin.write_bytes(b"X" * 1000)

        # Budget of 500 bytes should fail closed
        with pytest.raises(BudgetExceededError):
            preserve_session_history(session_id, output_dir, state_dir=state_dir, max_bytes=500)


def test_preserve_session_history_path_traversal_rejected():
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = pathlib.Path(tmp_dir)
        output_dir = tmp_path / "archive"

        with pytest.raises(HistoryPreservationError):
            preserve_session_history("../malicious_session", output_dir)
