"""
tests/test_admission.py - Comprehensive Unit Tests for RAM-Admission & Inflight Ledger
"""

import os
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from radar.admission import (
    AdmissionLease,
    AdmissionManager,
    format_rusage_children_telemetry,
    get_mem_available_mb,
    get_psi_memory_some_avg10,
)


class TestAdmissionTelemetry(unittest.TestCase):
    """Test telemetry extraction and fail-closed invariants."""

    def test_get_mem_available_mb_real_or_none(self):
        """Test reading real /proc/meminfo or failing closed to None."""
        val = get_mem_available_mb()
        if os.path.exists("/proc/meminfo"):
            self.assertIsNotNone(val)
            self.assertIsInstance(val, float)
            self.assertGreater(val, 0.0)
        else:
            self.assertIsNone(val)

    def test_get_mem_available_mb_missing_file_returns_none(self):
        """Unreadable or missing /proc/meminfo MUST return None, NEVER an invented default."""
        with patch("radar.admission.os.path.exists", return_value=False):
            self.assertIsNone(get_mem_available_mb())

    def test_get_psi_memory_missing_file_returns_none(self):
        """Missing or unreadable PSI MUST return None, NEVER assume 0.0."""
        with patch("radar.admission.os.path.exists", return_value=False):
            self.assertIsNone(get_psi_memory_some_avg10())

    def test_get_psi_memory_parsing(self):
        """Test accurate parsing of Linux PSI memory line."""
        sample_psi = (
            "some avg10=2.45 avg60=1.12 avg300=0.50 total=1234567\n"
            "full avg10=0.10 avg60=0.05 avg300=0.01 total=12345\n"
        )
        with patch("builtins.open", unittest.mock.mock_open(read_data=sample_psi)):
            with patch("radar.admission.os.path.exists", return_value=True):
                val = get_psi_memory_some_avg10()
                self.assertEqual(val, 2.45)


class TestAdmissionManager(unittest.TestCase):
    """Test AdmissionManager inflight ledger, reserve, and concurrency."""

    def test_admission_happy_path(self):
        """Healthy host memory allows admission and tracks inflight ledger."""
        manager = AdmissionManager(
            reserve_mb=2048.0,
            default_job_estimate_mb=512.0,
            max_concurrency=2,
            queue_timeout_seconds=1.0,
            max_psi_some_avg10=10.0,
        )

        # Available: 4096 MB -> Reserve: 2048 MB -> Effective available: 2048 MB >= 512 MB
        with manager.acquire(total_budget_seconds=10.0, override_available_mb=4096.0, override_psi_avg10=0.5) as lease:
            self.assertTrue(lease.admitted)
            self.assertEqual(manager.inflight_jobs, 1)
            self.assertEqual(manager.inflight_mb, 512.0)
            self.assertGreater(lease.remaining_budget_seconds, 0.0)
            self.assertEqual(lease.details["reserve_mb"], 2048.0)
            self.assertEqual(lease.details["effective_available_mb"], 2048.0)

        # Lease automatically released on context exit
        self.assertEqual(manager.inflight_jobs, 0)
        self.assertEqual(manager.inflight_mb, 0.0)

    def test_admission_insufficient_memory_fails_closed(self):
        """When effective available < job estimate, admission is rejected with details."""
        manager = AdmissionManager(
            reserve_mb=2048.0,
            default_job_estimate_mb=512.0,
            max_concurrency=2,
            queue_timeout_seconds=0.05,
        )

        # Available: 2200 MB -> Reserve: 2048 MB -> Effective: 152 MB < 512 MB required
        lease = manager.acquire(total_budget_seconds=5.0, override_available_mb=2200.0)
        self.assertFalse(lease.admitted)
        self.assertEqual(lease.reason, "insufficient_memory")
        self.assertEqual(lease.error, "resource_skipped_insufficient_memory")
        self.assertEqual(lease.details["required_mb"], 512.0)
        self.assertEqual(lease.details["effective_available_mb"], 152.0)
        self.assertEqual(manager.inflight_jobs, 0)

    def test_admission_missing_telemetry_fails_closed(self):
        """When MemAvailable telemetry is None, strictly fails closed, NEVER assumes safe."""
        manager = AdmissionManager(reserve_mb=2048.0, default_job_estimate_mb=512.0)
        with patch("radar.admission.get_mem_available_mb", return_value=None):
            lease = manager.acquire(total_budget_seconds=5.0)
            self.assertFalse(lease.admitted)
            self.assertEqual(lease.reason, "telemetry_unavailable")
            self.assertEqual(lease.error, "resource_skipped_telemetry_unavailable")
            self.assertEqual(lease.details["error"], "memory_telemetry_unavailable")

    def test_admission_high_psi_pressure_fails_closed(self):
        """When PSI pressure exceeds threshold, admission is rejected with details."""
        manager = AdmissionManager(
            reserve_mb=1024.0,
            default_job_estimate_mb=256.0,
            max_psi_some_avg10=5.0,
            queue_timeout_seconds=0.05,
        )
        lease = manager.acquire(
            total_budget_seconds=5.0,
            override_available_mb=16384.0,
            override_psi_avg10=18.5,
        )
        self.assertFalse(lease.admitted)
        self.assertEqual(lease.reason, "high_memory_pressure")
        self.assertEqual(lease.error, "resource_skipped_high_memory_pressure")
        self.assertEqual(lease.details["psi_some_avg10"], 18.5)

    def test_admission_concurrency_limit_and_waiting(self):
        """When max_concurrency is reached, subsequent job waits and is admitted once capacity frees."""
        manager = AdmissionManager(
            reserve_mb=1024.0,
            default_job_estimate_mb=256.0,
            max_concurrency=1,
            queue_timeout_seconds=2.0,
        )

        events = []

        def worker_1():
            with manager.acquire(total_budget_seconds=5.0, override_available_mb=8192.0):
                events.append("w1_acquired")
                time.sleep(0.2)
                events.append("w1_releasing")

        def worker_2():
            time.sleep(0.05)
            with manager.acquire(total_budget_seconds=5.0, override_available_mb=8192.0) as lease:
                self.assertTrue(lease.admitted)
                events.append("w2_acquired")

        t1 = threading.Thread(target=worker_1)
        t2 = threading.Thread(target=worker_2)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        self.assertEqual(events, ["w1_acquired", "w1_releasing", "w2_acquired"])
        self.assertEqual(manager.inflight_jobs, 0)
        self.assertEqual(manager.inflight_mb, 0.0)

    def test_rusage_children_telemetry_attribution(self):
        """Verify format_rusage_children_telemetry includes explicit scope and source disclosure."""
        telemetry = format_rusage_children_telemetry()
        self.assertIn("cumulative_children_peak_rss_mb", telemetry)
        self.assertIn("peak_rss_mb", telemetry)
        self.assertEqual(telemetry["source"], "resource.RUSAGE_CHILDREN.ru_maxrss")
        self.assertEqual(telemetry["scope"], "cumulative_process_children")


if __name__ == "__main__":
    unittest.main()
