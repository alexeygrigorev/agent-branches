"""
radar/admission.py - RAM-Admission Queue, Inflight Ledger, and Process Bounding

Enforces resource-aware admission control for test execution jobs:
1. MemAvailable telemetry from /proc/meminfo (fail closed to None on unreadable/missing; NEVER invent fallback values).
2. PSI memory pressure telemetry from /proc/pressure/memory (fail closed to None on unreadable/missing; NEVER assume 0.0).
3. Inflight reservation ledger: effective_available = available - (reserve + inflight_estimated).
   Requires effective_available >= job_estimate.
4. Intra-process concurrency gate: Semaphore/Lock with explicit process-local scope disclosure.
5. Single unified deadline across queue wait, tree extraction, and test execution.
6. Cumulative children peak RSS telemetry with explicit scope attribution.
"""

from __future__ import annotations

import os
import re
import resource
import threading
import time
from typing import Any, Dict, Optional, Tuple


def get_mem_available_mb() -> Optional[float]:
    """Read MemAvailable from /proc/meminfo in megabytes.
    
    Returns:
        Available memory in MB, or None if /proc/meminfo cannot be read
        or does not contain MemAvailable. Never returns an invented default.
    """
    meminfo_path = "/proc/meminfo"
    if not os.path.exists(meminfo_path):
        return None
    try:
        with open(meminfo_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    parts = line.split()
                    if len(parts) >= 2:
                        kb_val = float(parts[1])
                        return kb_val / 1024.0
    except (OSError, ValueError):
        return None
    return None


def get_psi_memory_some_avg10() -> Optional[float]:
    """Read Linux PSI memory pressure 'some avg10' metric from /proc/pressure/memory.
    
    Returns:
        float percentage (0.0 - 100.0) or None if unavailable/unreadable.
        Never returns an invented default or assumes 0.0.
    """
    psi_path = "/proc/pressure/memory"
    if not os.path.exists(psi_path):
        return None
    try:
        with open(psi_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("some "):
                    match = re.search(r"avg10=([0-9.]+)", line)
                    if match:
                        return float(match.group(1))
    except (OSError, ValueError):
        return None
    return None


class AdmissionLease:
    """Represents an active or denied admission lease.
    
    Used as a context manager to automatically release inflight reservations.
    """

    def __init__(
        self,
        manager: Optional["AdmissionManager"],
        admitted: bool,
        deadline: float,
        job_estimate_mb: float,
        wait_time_seconds: float,
        reason: Optional[str] = None,
        error: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.manager = manager
        self.admitted = admitted
        self.deadline = deadline
        self.job_estimate_mb = job_estimate_mb
        self.wait_time_seconds = wait_time_seconds
        self.reason = reason
        self.error = error
        self.details = details or {}
        self._released = False

    @property
    def remaining_budget_seconds(self) -> float:
        """Remaining wall-clock budget before total deadline expires."""
        return max(0.0, self.deadline - time.time())

    def release(self) -> None:
        """Release the reservation back to the manager."""
        if not self._released and self.admitted and self.manager:
            self.manager._release_lease(self.job_estimate_mb)
            self._released = True

    def __enter__(self) -> "AdmissionLease":
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.release()


class AdmissionManager:
    """Manages memory admission, inflight reservation ledger, and process-level concurrency."""

    def __init__(
        self,
        reserve_mb: float = 2048.0,
        default_job_estimate_mb: float = 512.0,
        max_concurrency: int = 2,
        queue_timeout_seconds: float = 10.0,
        max_psi_some_avg10: float = 10.0,
        scope_name: str = "process_radar_engine",
    ) -> None:
        self.reserve_mb = reserve_mb
        self.default_job_estimate_mb = default_job_estimate_mb
        self.max_concurrency = max_concurrency
        self.queue_timeout_seconds = queue_timeout_seconds
        self.max_psi_some_avg10 = max_psi_some_avg10
        self.scope_name = scope_name

        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._inflight_jobs = 0
        self._inflight_mb = 0.0

    @property
    def inflight_jobs(self) -> int:
        with self._lock:
            return self._inflight_jobs

    @property
    def inflight_mb(self) -> float:
        with self._lock:
            return self._inflight_mb

    def _release_lease(self, job_estimate_mb: float) -> None:
        with self._lock:
            self._inflight_jobs = max(0, self._inflight_jobs - 1)
            self._inflight_mb = max(0.0, self._inflight_mb - job_estimate_mb)
            self._cond.notify_all()

    def acquire(
        self,
        total_budget_seconds: float,
        job_estimate_mb: Optional[float] = None,
        override_available_mb: Optional[float] = None,
        override_psi_avg10: Optional[float] = None,
    ) -> AdmissionLease:
        """Attempt to admit a test job under the single unified deadline.
        
        Formula:
            effective_available = available - (reserve + inflight_estimated)
            Admitted iff:
                inflight_jobs < max_concurrency AND
                effective_available >= job_estimate AND
                (psi is None OR psi <= max_psi)
        """
        job_est = job_estimate_mb if job_estimate_mb is not None else self.default_job_estimate_mb
        t_start = time.time()
        # Single unified deadline: queue timeout cannot exceed total budget
        effective_queue_timeout = min(self.queue_timeout_seconds, total_budget_seconds)
        queue_deadline = t_start + effective_queue_timeout
        total_deadline = t_start + total_budget_seconds

        last_details: Dict[str, Any] = {}
        last_reason = "unknown"
        last_error = "resource_skipped"

        while True:
            now = time.time()
            if now >= queue_deadline:
                wait_time = round(now - t_start, 3)
                return AdmissionLease(
                    manager=self,
                    admitted=False,
                    deadline=total_deadline,
                    job_estimate_mb=job_est,
                    wait_time_seconds=wait_time,
                    reason=last_reason,
                    error=last_error,
                    details=last_details,
                )

            with self._lock:
                # 1. Concurrency limit
                if self._inflight_jobs >= self.max_concurrency:
                    last_reason = "concurrency_limit_reached"
                    last_error = "resource_skipped_concurrency_limit"
                    last_details = {
                        "inflight_jobs": self._inflight_jobs,
                        "max_concurrency": self.max_concurrency,
                        "concurrency_scope": self.scope_name,
                        "summary": "resource-skipped: concurrency limit reached",
                    }
                    rem_wait = min(0.05, max(0.005, queue_deadline - time.time()))
                    self._cond.wait(timeout=rem_wait)
                    continue

                # 2. Memory Available telemetry
                current_mem = override_available_mb if override_available_mb is not None else get_mem_available_mb()
                if current_mem is None:
                    # Fail closed: telemetry unavailable, NEVER assume healthy
                    wait_time = round(time.time() - t_start, 3)
                    return AdmissionLease(
                        manager=self,
                        admitted=False,
                        deadline=total_deadline,
                        job_estimate_mb=job_est,
                        wait_time_seconds=wait_time,
                        reason="telemetry_unavailable",
                        error="resource_skipped_telemetry_unavailable",
                        details={
                            "error": "memory_telemetry_unavailable",
                            "summary": "resource-skipped: memory telemetry unavailable (/proc/meminfo unreadable)",
                            "concurrency_scope": self.scope_name,
                        },
                    )

                # 3. PSI memory pressure telemetry
                current_psi = override_psi_avg10 if override_psi_avg10 is not None else get_psi_memory_some_avg10()
                if current_psi is not None and current_psi > self.max_psi_some_avg10:
                    last_reason = "high_memory_pressure"
                    last_error = "resource_skipped_high_memory_pressure"
                    last_details = {
                        "psi_some_avg10": round(current_psi, 2),
                        "max_psi_some_avg10": self.max_psi_some_avg10,
                        "concurrency_scope": self.scope_name,
                        "summary": "resource-skipped: high memory pressure",
                    }
                    rem_wait = min(0.05, max(0.005, queue_deadline - time.time()))
                    self._cond.wait(timeout=rem_wait)
                    continue

                # 4. Inflight ledger calculation
                effective_available = current_mem - (self.reserve_mb + self._inflight_mb)
                if effective_available < job_est:
                    last_reason = "insufficient_memory"
                    last_error = "resource_skipped_insufficient_memory"
                    last_details = {
                        "mem_available_mb": round(current_mem, 1),
                        "reserve_mb": self.reserve_mb,
                        "inflight_mb": self._inflight_mb,
                        "effective_available_mb": round(effective_available, 1),
                        "required_mb": job_est,
                        "concurrency_scope": self.scope_name,
                        "summary": "resource-skipped: insufficient memory",
                    }
                    rem_wait = min(0.05, max(0.005, queue_deadline - time.time()))
                    self._cond.wait(timeout=rem_wait)
                    continue

                # Admitted!
                self._inflight_jobs += 1
                self._inflight_mb += job_est
                wait_time = round(time.time() - t_start, 3)
                return AdmissionLease(
                    manager=self,
                    admitted=True,
                    deadline=total_deadline,
                    job_estimate_mb=job_est,
                    wait_time_seconds=wait_time,
                    details={
                        "mem_available_mb": round(current_mem, 1),
                        "reserve_mb": self.reserve_mb,
                        "inflight_mb": self._inflight_mb,
                        "effective_available_mb": round(effective_available, 1),
                        "psi_some_avg10": round(current_psi, 2) if current_psi is not None else None,
                        "concurrency_scope": self.scope_name,
                    },
                )


def format_rusage_children_telemetry() -> Dict[str, Any]:
    """Capture resource.RUSAGE_CHILDREN maxrss with rigorous disclosure.
    
    Discloses that ru_maxrss is cumulative across all previous/current children
    of this process, NOT isolated to a single execution.
    """
    ru = resource.getrusage(resource.RUSAGE_CHILDREN)
    return {
        "cumulative_children_peak_rss_mb": round(max(ru.ru_maxrss, 0) / 1024.0, 2),
        "peak_rss_mb": round(max(ru.ru_maxrss, 0) / 1024.0, 2),
        "source": "resource.RUSAGE_CHILDREN.ru_maxrss",
        "scope": "cumulative_process_children",
    }
