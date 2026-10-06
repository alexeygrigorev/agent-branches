# Independent Review: Agent Quota Launcher Capacity Ceiling Generalization & Watchdog Cooldown Remediation

- **Reviewer**: Independent Code & Architecture Reviewer (Antigravity Subagent)
- **Reviewer Conversation ID**: `b56e0876-3dc7-4931-ae7c-ed076cbf48b9`
- **Caller Agent ID**: `ea14b401-20e9-4e48-ab08-d15be08da30d`
- **Date**: 2026-10-06
- **Audited Target Repository**: `/home/alexey/git/agent-quota-launcher` (Read-Only)
- **Report Destination Repository**: `/home/alexey/git/agent-branches`
- **Audited Commits**:
  - `6a506a1a0feb5d450b16773d7ea11981aecd1b8d` (`6a506a1`): `fix(capacity): generalize max_cap constraint and remove arbitrary codex concurrency ceiling`
  - `eb9158e1965e4ddd6f95b783e3acfc274ec3b64f` (`eb9158e`): `fix(watch): add cleanup retry cooldown to prevent rapid retry storms on failure`
  - Supporting context: `a1e3f845039d8ba0685345e6bb6ec6e7068489f5` (`a1e3f84`): `fix(watch): relax cleanup timeout to 600s and allow CLI cleanup_timeout override`
- **Target Test Command**: `PYTHONPATH=/home/alexey/git/agent-quota-launcher pytest -v /home/alexey/git/agent-quota-launcher/tests/test_capacity.py /home/alexey/git/agent-quota-launcher/tests/test_watch.py`
- **Final Verdict**: **ACCEPTED**

---

## 1. Executive Summary

This independent review evaluates the remediation of two operational defects in `agent-quota-launcher`:
1. **Removal of Arbitrary Codex Concurrency Ceiling & Generalization of `max_cap` (Commit `6a506a1`)**:
   - In commit `665ba3b`, an arbitrary hardcoded limit of `DEFAULT_MAX_CONCURRENT_CODEX = 6` was introduced under the mistaken commit label `(Luna <= 6)`. This conflated the model designation (`GPT-6 Luna MAX`) with an artificial hostwide concurrency ceiling of 6, in direct violation of the human steering mandate (User Message 26) which forbids arbitrary policy caps or fixed team-size limits.
   - Commit `6a506a1` completely removed `DEFAULT_MAX_CONCURRENT_CODEX = 6`, eliminated the hardcoded codex branch in admission/reservation, and generalized the `max_cap` parameter so that callers can impose explicit ceilings on any provider while leaving default Codex/Antigravity/OpenCode concurrency unconstrained by arbitrary caps (governed instead by authentic quota gates and host resources).
2. **Watchdog Cleanup Timeout Relaxation & Failure Cooldown (Commits `a1e3f84` & `eb9158e`)**:
   - In commit `a1e3f84`, the disk-pressure cleanup timeout was relaxed from 120s to 600s (`DEFAULT_CLEANUP_TIMEOUT_SEC = 600`) to prevent premature timeout termination during deep directory scans and pruning operations.
   - In commit `eb9158e`, a SQL-backed cooldown check was added to `launcher/watch.py`. When disk pressure is detected (< 30 GiB free) and a prior cleanup task failed, `watch_loop` calculates elapsed seconds using `(strftime('%s', 'now') - strftime('%s', updated_at))`. Retries are suppressed for 300 seconds (`cleanup_cooldown_sec`), preventing rapid-fire retry storms across loop passes and process restarts.

All 23 targeted unit tests across `tests/test_capacity.py` and `tests/test_watch.py` pass without regression. The code was audited against edge cases, concurrency isolation, and schema contracts.

---

## 2. Commit Audit: `6a506a1` (Capacity Generalization & Codex Ceiling Removal)

### 2.1 Root Cause Analysis of Conflation
In earlier commit `665ba3b` (`feat(capacity): add hostwide codex capacity ceiling and reservation checks (Luna <= 6)`), the author added:
```python
DEFAULT_MAX_CONCURRENT_CODEX = 6
```
The commit message specifically referenced `(Luna <= 6)`. This indicates that the model naming token `GPT-6 Luna MAX` (where `6` denotes model generation) was conflated with an allowable concurrency quota of 6 processes.
Per User Message 26:
> *"Heads and task executors may launch as many useful headless workers and native harness subagents as needed for the authorized projects. There is no fixed two-executor-per-head limit or arbitrary team-size cap. Allocate concurrency according to concrete independent tasks, actual available provider capacity, host resources and useful measured outcomes... Harness limits are technical limits, not a reason to reintroduce a policy cap."*

For OpenAI Codex, execution admission is strictly gated by the real 15% quota remaining gate, not an arbitrary 6-task hostwide ceiling. Hardcoding 6 artificially throttled parallel Codex execution across projects.

### 2.2 Diff Analysis of `launcher/capacity.py`
In `launcher/capacity.py`:
- `DEFAULT_MAX_CONCURRENT_CODEX = 6` was removed from module constants (leaving only `DEFAULT_MAX_CONCURRENT_ZAI = 26`).
- In `check_provider_capacity(provider, max_cap=None, ...)`:
  - The provider-specific `if provider == "codex":` block was replaced with a generic `if max_cap is not None:` block:
    ```python
    # 4. Explicit max_cap ceiling check (when max_cap is explicitly specified)
    if max_cap is not None:
        ceiling = max_cap
        with open(lock_file, "a") as f:
            fcntl.flock(f, fcntl.LOCK_SH)
            try:
                raw_res = _load_reservations(res_file)
                prov_res = {
                    tok: info for tok, info in raw_res.items()
                    if info.get("provider") == provider and ts < info.get("expires_at", 0)
                }
                reserved_count = len(prov_res)
                if reserved_count >= ceiling:
                    reason = (
                        f"{provider} hostwide capacity ceiling ({ceiling}) reached: "
                        f"{reserved_count} reserved (total {reserved_count} >= {ceiling})"
                    )
                    return False, reason, {
                        "provider": provider,
                        "reserved_count": reserved_count,
                        "ceiling": ceiling,
                        "headroom": 0,
                    }
                return True, None, {
                    "provider": provider,
                    "reserved_count": reserved_count,
                    "ceiling": ceiling,
                    "headroom": max(0, ceiling - reserved_count),
                }
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)
    ```
  - When `max_cap is None` and `provider != "zai"`, execution falls through to:
    ```python
    # Default for other providers (codex, antigravity, opencode)
    return True, None, {"provider": provider, "admitted": True}
    ```
- In `reserve_provider_slot(provider, task_id, max_cap=None, ...)`:
  - The `if provider == "codex":` check was replaced with:
    ```python
    if max_cap is not None and provider != "zai":
        ceiling = max_cap
        prov_res = {tok: info for tok, info in cleaned.items() if info.get("provider") == provider}
        if len(prov_res) >= ceiling:
            raise ConcurrencyLimitExceeded(
                f"Hostwide {provider} capacity ceiling ({ceiling}) reached! "
                f"Pending reservations: {len(prov_res)} >= {ceiling}. Reservation rejected."
            )
    ```
  - This cleanly preserves the ZAI fixed hostwide limit of 26 while allowing callers to impose an explicit `max_cap` on any other provider (`codex`, `antigravity`, `opencode`) if desired. When `max_cap` is omitted, no artificial limit is enforced.

### 2.3 Test Audit: `tests/test_capacity.py`
The test suite was updated:
1. `test_codex_capacity_under_and_at_ceiling` was replaced by:
   - `test_default_codex_capacity_unconstrained_by_arbitrary_ceiling`: Verifies default admission of `codex` returns `can_admit=True`, `reason=None`, `admitted=True`.
   - `test_explicit_max_cap_under_and_at_ceiling`: Sets `max_cap=5`, reserves 5 slots, verifies admission headroom calculation, validates that the 6th reservation raises `ConcurrencyLimitExceeded`, and verifies slot release restores headroom.

---

## 3. Commit Audit: `eb9158e` & `a1e3f84` (Watchdog Timeout & Cooldown)

### 3.1 Cleanup Timeout Relaxation (`a1e3f84`)
- In `launcher/watch.py`, `DEFAULT_CLEANUP_TIMEOUT_SEC = 600` was established.
- `CLEANUP_PAYLOAD["timeout"]` was increased from 120s to 600s.
- `watch_loop` checks `getattr(args, "cleanup_timeout", None)` and allows overriding payload timeout dynamically.
- This addresses the observed failure mode where disk cleanup jobs running under heavy system I/O exceeded 120s and were killed as stalled/failed tasks.

### 3.2 Cleanup Retry Storm Prevention (`eb9158e`)
- **Vulnerability Mechanism**:
  Before commit `eb9158e`, when disk space fell below 30 GiB (`WARN_DISK_FREE_BYTES`), `check_disk_pressure` requested a cleanup enqueue. If the cleanup task failed (e.g. exit code != 0 or timeout), its state transitioned from `starting`/`running` to `failed`.
  On subsequent passes or across process restarts, `has_active` returned `False` because the previous task was no longer active (`queued`, `starting`, `running`, `launch-uncertain`, `stalled`). The watcher immediately incremented `episode_id` and enqueued `disk-pressure-cleanup-2`, `disk-pressure-cleanup-3`, etc., on every tick or `--once` invocation, creating a rapid failure retry storm.
- **Cooldown Implementation**:
  In `launcher/watch.py` lines 228–243:
  ```python
  cooldown_sec = float(getattr(args, "cleanup_cooldown_sec", 300.0))
  recent_cleanup = False
  cursor = conn.execute(
      "SELECT state, (strftime('%s', 'now') - strftime('%s', updated_at)) "
      "FROM tasks WHERE idempotency_key LIKE 'disk-pressure-cleanup-%' "
      "ORDER BY created_at DESC LIMIT 1"
  )
  row = cursor.fetchone()
  if row and row[0] == "failed" and row[1] is not None:
      try:
          elapsed = float(row[1])
          if elapsed < cooldown_sec:
              recent_cleanup = True
      except Exception:
          pass

  if not has_active and not recent_cleanup:
      # enqueue new cleanup task
      ...
  elif recent_cleanup:
      print(f"watcher: disk pressure detected but cleanup episode in cooldown ({cooldown_sec}s); skipping enqueue")
  ```
- **Integrity of SQLite Query**:
  - `tasks.updated_at` is maintained by SQLite `CURRENT_TIMESTAMP` (formatted as UTC `YYYY-MM-DD HH:MM:SS`).
  - SQLite's `strftime('%s', 'now')` and `strftime('%s', updated_at)` calculate unix epoch seconds in UTC.
  - The arithmetic `(strftime('%s', 'now') - strftime('%s', updated_at))` computes integer seconds elapsed since the task transitioned to `failed`.
  - The check `elapsed < cooldown_sec` suppresses retry creation for 300 seconds.

### 3.3 Test Audit: `tests/test_watch.py`
Commit `eb9158e` added `test_disk_pressure_cleanup_cooldown_prevents_retry_storm`:
- Simulates disk free space at 28 GiB (< 30 GiB warning threshold).
- Runs Pass 1: verifies `disk-pressure-cleanup-1` is created.
- Simulates failure: transitions `disk-pressure-cleanup-1` to `starting` then `failed`.
- Runs Pass 2 immediately at 28 GiB: verifies `disk-pressure-cleanup-2` is NOT enqueued (`assertIsNone(t2)`).

---

## 4. Test Verification Results

Targeted test suite executed in `/home/alexey/git/cloudflare-agent-git` using:
```bash
PYTHONPATH=/home/alexey/git/agent-quota-launcher pytest -v \
  /home/alexey/git/agent-quota-launcher/tests/test_capacity.py \
  /home/alexey/git/agent-quota-launcher/tests/test_watch.py
```

### Execution Log Summary
```text
============================= test session starts ==============================
platform linux -- Python 3.12.3, pytest-9.1.1, pluggy-1.6.0 -- /usr/bin/python3
rootdir: /home/alexey/git/agent-quota-launcher
configfile: pyproject.toml
plugins: anyio-4.12.1, opik-2.2.54
collected 23 items

../agent-quota-launcher/tests/test_capacity.py::TestProviderCapacity::test_429_cooldown_lifecycle PASSED [  4%]
../agent-quota-launcher/tests/test_capacity.py::TestProviderCapacity::test_atomic_reservation_and_release PASSED [  8%]
../agent-quota-launcher/tests/test_capacity.py::TestProviderCapacity::test_check_provider_capacity_at_ceiling PASSED [ 13%]
../agent-quota-launcher/tests/test_capacity.py::TestProviderCapacity::test_check_provider_capacity_outside_project_occupancy_affects_admission PASSED [ 17%]
../agent-quota-launcher/tests/test_capacity.py::TestProviderCapacity::test_check_provider_capacity_under_ceiling PASSED [ 21%]
../agent-quota-launcher/tests/test_capacity.py::TestProviderCapacity::test_default_codex_capacity_unconstrained_by_arbitrary_ceiling PASSED [ 26%]
../agent-quota-launcher/tests/test_capacity.py::TestProviderCapacity::test_explicit_max_cap_under_and_at_ceiling PASSED [ 30%]
../agent-quota-launcher/tests/test_capacity.py::TestProviderCapacity::test_get_live_zai_pids_discovery PASSED [ 34%]
../agent-quota-launcher/tests/test_capacity.py::TestProviderCapacity::test_provider_reservation_context_manager_cleans_up_on_error PASSED [ 39%]
../agent-quota-launcher/tests/test_capacity.py::TestProviderCapacity::test_reservation_exceeds_ceiling_raises PASSED [ 43%]
../agent-quota-launcher/tests/test_capacity.py::TestProviderCapacity::test_validate_quse_capacity_check_excludes_capped_zai_and_keeps_antigravity PASSED [ 47%]
../agent-quota-launcher/tests/test_watch.py::WatchRefillTests::test_accept_triggers_refill_dispatch PASSED [ 52%]
../agent-quota-launcher/tests/test_watch.py::WatchRefillTests::test_bare_proposal_without_substantive_prompt_blocked PASSED [ 56%]
../agent-quota-launcher/tests/test_watch.py::WatchRefillTests::test_derive_task_tmpdir_contained PASSED [ 60%]
../agent-quota-launcher/tests/test_watch.py::WatchRefillTests::test_disk_pressure_29_gib_eligible_continues_and_cleanup_enqueued PASSED [ 65%]
../agent-quota-launcher/tests/test_watch.py::WatchRefillTests::test_disk_pressure_cleanup_cooldown_prevents_retry_storm PASSED [ 69%]
../agent-quota-launcher/tests/test_watch.py::WatchRefillTests::test_disk_pressure_deduplication_multiple_passes_at_29_gib PASSED [ 73%]
../agent-quota-launcher/tests/test_watch.py::WatchRefillTests::test_disk_pressure_hard_floor_rejection_below_20_gib PASSED [ 78%]
../agent-quota-launcher/tests/test_watch.py::WatchRefillTests::test_disk_pressure_rearm_at_30_gib_and_subsequent_drop PASSED [ 82%]
../agent-quota-launcher/tests/test_watch.py::WatchRefillTests::test_independent_tasks_dispatch_when_another_awaiting_review PASSED [ 86%]
../agent-quota-launcher/tests/test_watch.py::WatchRefillTests::test_run_task_units_does_not_trigger_refill_on_exit_zero PASSED [ 91%]
../agent-quota-launcher/tests/test_watch.py::WatchRefillTests::test_watch_loop_dispatches_with_task_local_tmpdir_not_args_tmpdir PASSED [ 95%]
../agent-quota-launcher/tests/test_watch.py::WatchRefillTests::test_watch_loop_waits_for_unreviewed_tasks PASSED [100%]

============================== 23 passed in 2.41s ==============================
```

All 23 test cases passed.

---

## 5. Identified Limitations and Open Risks

1. **Test Coverage of Default Codex Unconstrained Reservations**:
   - `test_default_codex_capacity_unconstrained_by_arbitrary_ceiling` verifies admission check with 0 reservations (`info.get("admitted") == True`). It does not explicitly allocate > 6 concurrent reservations without `max_cap` to prove end-to-end multi-slot admission.
   - *Impact*: Low. The implementation in `reserve_provider_slot` (`if max_cap is not None and provider != "zai":`) unambiguously skips concurrency check when `max_cap is None`.
2. **Cooldown Re-Arm Negative Test Coverage**:
   - `test_disk_pressure_cleanup_cooldown_prevents_retry_storm` confirms suppression during the active 300s window. It does not test that when `updated_at` is older than 300s, a subsequent pass successfully enqueues `disk-pressure-cleanup-2`.
   - *Impact*: Low. The condition `elapsed < cooldown_sec` will evaluate to `False` once `elapsed >= 300.0`, allowing normal re-enqueue.
3. **CLI Argument Registration in `parser_watch`**:
   - In `launcher/cli.py`, `parser_watch` does not expose `--cleanup-cooldown-sec` or `--cleanup-timeout` flags.
   - *Impact*: Informational. The watcher defaults to `300.0` seconds cooldown and `600` seconds timeout. Overrides are only possible programmatically via `args` attributes. If CLI customization is required in the future, explicit CLI flags should be added to `parser_watch`.
4. **Completed Task Persistence Across Watcher Restarts**:
   - The cooldown logic explicitly checks `row[0] == "failed"`. If a cleanup task finishes with exit code 0 (`completed-awaiting-review`), but disk space was not sufficiently freed (free remains < 30 GiB), the running daemon's in-memory `episode_state["in_episode"]` prevents re-enqueueing. If the daemon restarts, `in_episode` initializes to `False`, and because `row[0] != "failed"`, a new cleanup task will be enqueued.
   - *Impact*: Low. Succeeded cleanups that leave disk low are rare; failure loops were the primary trigger for retry storms.

---

## 6. Final Verdict

**VERDICT: ACCEPTED**

### Justification:
1. **Model Name Conflation Resolved**: Commit `6a506a1` cleanly eliminates the conflation between `GPT-6 Luna MAX` and a concurrency ceiling of 6. The arbitrary `DEFAULT_MAX_CONCURRENT_CODEX = 6` is completely removed, restoring compliance with User Message 26.
2. **Generalized `max_cap`**: The parameter is now unified across providers while maintaining the strict 26-task ceiling for ZAI.
3. **Watchdog Cooldown & Timeout**: Commit `eb9158e` and supporting commit `a1e3f84` provide effective relief against timeout thrashing (relaxed to 600s) and rapid retry storms on failure (300s cooldown via SQLite elapsed timestamp arithmetic).
4. **Empirical Verification**: All 23 targeted tests pass cleanly in 2.41s. No regressions detected.
