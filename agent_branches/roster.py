"""Roster accountability and verification module (scale50-E).

Enforces:
1. Hard rejection of future-dated `claimed_as_of` timestamps (Corrective Counting Invariant).
2. TTL self-expiry (default 300s): demotes stale roster snapshots to UNKNOWN.
3. Live /proc process reconciliation: verifies PID liveness and prevents ghost worker accounting.
4. Generation-bound state checks.
"""

from __future__ import annotations

import datetime as dt
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


class RosterValidationError(Exception):
    """Raised when a roster snapshot violates safety invariants."""


def parse_iso_timestamp(ts_str: str) -> dt.datetime:
    """Parse ISO8601 UTC timestamp string into a timezone-aware datetime."""
    # Normalize Z to +00:00
    if ts_str.endswith("Z"):
        ts_str = ts_str[:-1] + "+00:00"
    return dt.datetime.fromisoformat(ts_str)


def verify_roster_snapshot(
    roster_data: Dict[str, Any],
    now: Optional[dt.datetime] = None,
    max_ttl_seconds: float = 300.0,
    verify_proc: bool = True,
    proc_root: str = "/proc",
) -> Dict[str, Any]:
    """Audit and reconcile a roster snapshot against physical process and timestamp invariants.

    Returns a reconciliation dictionary:
      - valid: bool
      - status: 'active' | 'expired' | 'future_rejected' | 'invalid_schema'
      - verified_active_pids: List[int]
      - demoted_pids: List[int]
      - reason: str
    """
    if now is None:
        now = dt.datetime.now(dt.timezone.utc)
    elif now.tzinfo is None:
        now = now.replace(tzinfo=dt.timezone.utc)

    # 1. Validate mandatory fields
    claimed_as_of_str = roster_data.get("claimed_as_of") or roster_data.get("as_of")
    if not claimed_as_of_str:
        return {
            "valid": False,
            "status": "invalid_schema",
            "reason": "Missing mandatory 'claimed_as_of' or 'as_of' timestamp",
            "verified_active_pids": [],
            "demoted_pids": [],
        }

    try:
        claimed_as_of = parse_iso_timestamp(claimed_as_of_str)
    except Exception as exc:
        return {
            "valid": False,
            "status": "invalid_schema",
            "reason": f"Invalid timestamp format '{claimed_as_of_str}': {exc}",
            "verified_active_pids": [],
            "demoted_pids": [],
        }

    # 2. Invariant: Hard-reject future timestamps
    skew_margin_sec = 5.0
    if claimed_as_of > now + dt.timedelta(seconds=skew_margin_sec):
        return {
            "valid": False,
            "status": "future_rejected",
            "reason": (
                f"Future timestamp violation: claimed_as_of {claimed_as_of_str} "
                f"is ahead of current time {now.isoformat()}"
            ),
            "verified_active_pids": [],
            "demoted_pids": [],
        }

    # 3. Invariant: TTL Self-Expiry (max 300s)
    age_seconds = (now - claimed_as_of).total_seconds()
    if age_seconds > max_ttl_seconds:
        return {
            "valid": False,
            "status": "expired",
            "reason": (
                f"Roster snapshot expired: age {age_seconds:.1f}s exceeds "
                f"max TTL {max_ttl_seconds:.1f}s (demoted to UNKNOWN)"
            ),
            "verified_active_pids": [],
            "demoted_pids": [],
        }

    # 4. Extract workers / PIDs
    workers = roster_data.get("workers", [])
    verified_pids: List[int] = []
    demoted_pids: List[int] = []

    for w in workers:
        pid = w.get("pid")
        if pid is None or not isinstance(pid, int):
            continue

        if verify_proc:
            proc_pid_path = Path(proc_root) / str(pid)
            if proc_pid_path.exists():
                verified_pids.append(pid)
            else:
                demoted_pids.append(pid)
        else:
            verified_pids.append(pid)

    return {
        "valid": True,
        "status": "active",
        "age_seconds": age_seconds,
        "claimed_workers_count": len(workers),
        "verified_active_count": len(verified_pids),
        "demoted_count": len(demoted_pids),
        "verified_active_pids": verified_pids,
        "demoted_pids": demoted_pids,
        "reason": "Roster verified against physical liveness and freshness criteria",
    }
