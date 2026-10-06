"""Unit tests for roster verification and TTL self-expiry (scale50-E)."""

from __future__ import annotations

import datetime as dt
import os
import tempfile
from pathlib import Path

import pytest

from agent_branches.roster import parse_iso_timestamp, verify_roster_snapshot


def test_parse_iso_timestamp():
    ts = parse_iso_timestamp("2026-10-06T12:00:00Z")
    assert ts.year == 2026
    assert ts.tzinfo is not None

    ts2 = parse_iso_timestamp("2026-10-06T12:00:00+02:00")
    assert ts2.tzinfo is not None


def test_roster_future_timestamp_rejected():
    now = dt.datetime(2026, 10, 6, 12, 0, 0, tzinfo=dt.timezone.utc)
    # Roster claims timestamp 1 hour in the future
    roster = {
        "claimed_as_of": "2026-10-06T13:00:00Z",
        "workers": [{"pid": 1234, "role": "worker"}],
    }

    res = verify_roster_snapshot(roster, now=now)
    assert not res["valid"]
    assert res["status"] == "future_rejected"
    assert "Future timestamp violation" in res["reason"]


def test_roster_ttl_expired():
    now = dt.datetime(2026, 10, 6, 12, 10, 0, tzinfo=dt.timezone.utc)
    # Roster is 10 minutes (600s) old, exceeding 300s TTL
    roster = {
        "claimed_as_of": "2026-10-06T12:00:00Z",
        "workers": [{"pid": 1234, "role": "worker"}],
    }

    res = verify_roster_snapshot(roster, now=now, max_ttl_seconds=300.0)
    assert not res["valid"]
    assert res["status"] == "expired"
    assert "Roster snapshot expired" in res["reason"]


def test_roster_proc_liveness_reconciliation():
    now = dt.datetime(2026, 10, 6, 12, 2, 0, tzinfo=dt.timezone.utc)

    with tempfile.TemporaryDirectory() as tmp_proc:
        # Mock /proc: create a fake PID directory for 1001, but not 1002
        pid_live = 1001
        pid_dead = 1002
        (Path(tmp_proc) / str(pid_live)).mkdir()

        roster = {
            "claimed_as_of": "2026-10-06T12:01:00Z",
            "workers": [
                {"pid": pid_live, "role": "worker-live"},
                {"pid": pid_dead, "role": "worker-dead"},
            ],
        }

        res = verify_roster_snapshot(roster, now=now, max_ttl_seconds=300.0, verify_proc=True, proc_root=tmp_proc)
        assert res["valid"]
        assert res["status"] == "active"
        assert res["claimed_workers_count"] == 2
        assert res["verified_active_count"] == 1
        assert res["demoted_count"] == 1
        assert res["verified_active_pids"] == [pid_live]
        assert res["demoted_pids"] == [pid_dead]
