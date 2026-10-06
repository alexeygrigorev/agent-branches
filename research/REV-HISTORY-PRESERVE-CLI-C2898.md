# Independent Audit & Review: Bounded History Preservation CLI Integration (C2898)

- **Review Target Commit**: `f060c7e` (`feat(cli): add history preserve command for bounded session archiving`)
- **Review Target Receipt**: [`research/RECEIPT-HISTORY-PRESERVE-CLI-C2898.md`](file:///home/alexey/git/agent-branches/research/RECEIPT-HISTORY-PRESERVE-CLI-C2898.md)
- **Task ID**: `t-branches-history-cli-c2898`
- **Assigned Reviewer**: `t-branches-review-history-cli-c2898`
- **Reviewer Conversation ID**: `8bf0f124-42c2-4db7-94df-a99a24d79393`
- **Review Timestamp**: `2026-10-06T15:37:30Z`
- **Target Repository**: `/home/alexey/git/agent-branches`
- **Final Verdict**: **ACCEPTED**

---

## 1. Executive Summary

Commit `f060c7e` introduces the `history preserve` subcommand to the `agent-branches` CLI, exposing the bounded session history preservation engine ([`agent_branches/history_preserve.py`](file:///home/alexey/git/agent-branches/agent_branches/history_preserve.py)) directly via:

```bash
branches history preserve --session-id <session_id> --output-dir <target_dir> [--state-dir <state_dir>] [--max-bytes <bytes>] [--json]
```

This completes Stream 3 / Task C2898 (`t-branches-history-cli-c2898`) addressing maintainer friction intake C2889 and recovery governance requirements.

An objective, rigorous independent audit was conducted across code quality, argument binding, exit code semantics, security bounds, empirical testing, and cross-repository isolation.

---

## 2. Code Inspection & Architectural Analysis

### 2.1 Subparser Registration
Source: [`agent_branches/cli.py:460-469`](file:///home/alexey/git/agent-branches/agent_branches/cli.py#L460-L469)

```python
    # history command (Bounded session history preservation)
    history_parser = subparsers.add_parser("history", help="Bounded session history preservation")
    history_sub = history_parser.add_subparsers(dest="history_action", help="History actions")

    history_preserve = history_sub.add_parser("preserve", help="Preserve session history into bounded private archive")
    history_preserve.add_argument("--session-id", required=True, help="Session identifier")
    history_preserve.add_argument("--output-dir", required=True, help="Target output directory")
    history_preserve.add_argument("--state-dir", help="Path to aplexer state directory (default: ~/.local/state/aplexer)")
    history_preserve.add_argument("--max-bytes", type=int, default=50 * 1024 * 1024, help="Max budget in bytes (default: 50 MiB)")
    history_preserve.add_argument("--json", action="store_true", help="Output raw JSON")
```

**Verification Assessment**:
- **Hierarchy**: `history preserve` is registered under `subparsers` using a clean nested subparser pattern (`history_action`).
- **Required Arguments**: `--session-id` and `--output-dir` are marked `required=True`, preventing invalid invocations early during argument parsing.
- **Optional Overrides**: `--state-dir` allows specifying custom aplexer root paths (defaulting cleanly inside `history_preserve.py` to `~/.local/state/aplexer`).
- **Configurable Storage Ceiling**: `--max-bytes` is parsed as an `int` with a safe default of 50 MiB (`52,428,800` bytes).
- **Format Flag**: `--json` provides machine-readable output.

### 2.2 CLI Handler Implementation (`handle_history_preserve`)
Source: [`agent_branches/cli.py:1045-1070`](file:///home/alexey/git/agent-branches/agent_branches/cli.py#L1045-L1070)

```python
def handle_history_preserve(args: argparse.Namespace, as_json: bool) -> int:
    from pathlib import Path
    from agent_branches.history_preserve import preserve_session_history, HistoryPreservationError
    try:
        output_dir = Path(args.output_dir)
        state_dir = Path(args.state_dir) if args.state_dir else None
        res = preserve_session_history(
            session_id=args.session_id,
            output_dir=output_dir,
            state_dir=state_dir,
            max_bytes=args.max_bytes,
        )
        if as_json:
            print(json.dumps(res, indent=2))
        else:
            print(f"[HISTORY PRESERVED] Session: {res.get('session_id')}")
            print(f"  Archive Path: {res.get('archive_path')}")
            print(f"  History Bytes: {res.get('history_bytes')}")
            print(f"  Metadata: {res.get('meta_file')}")
        return 0
    except HistoryPreservationError as e:
        if as_json:
            print(json.dumps({"error": str(e), "status": "failed"}, indent=2))
        else:
            print(f"Error: {e}", file=sys.stderr)
        return 1
```

**Verification Assessment**:
- **Scoped Imports**: Defers import of `preserve_session_history` and `HistoryPreservationError`, ensuring negligible overhead on general CLI startup.
- **Parameter Mapping**: Correctly maps `session_id`, `output_dir` (as `pathlib.Path`), `state_dir`, and `max_bytes`.
- **Exit Code Semantics**:
  * Returns `0` on successful preservation.
  * Catches `HistoryPreservationError` (including child exceptions `SessionNotFoundError` and `BudgetExceededError`) and returns `1`.
- **Output Consistency**:
  * Human-readable branch prints clean summary to `stdout` and error to `stderr`.
  * Machine-readable `--json` emits structured JSON to `stdout` on both success and error states.

### 2.3 Command Dispatching in `main()`
Source: [`agent_branches/cli.py:1132-1137`](file:///home/alexey/git/agent-branches/agent_branches/cli.py#L1132-L1137)

```python
        elif args.command == "history":
            if getattr(args, "history_action", None) == "preserve":
                return handle_history_preserve(args, as_json)
            else:
                parser.parse_args(["history", "--help"])
                return 1
```

**Verification Assessment**:
- Dispatches smoothly to `handle_history_preserve`.
- Emits contextual help and returns exit code `1` if an unhandled action is provided.

### 2.4 Unit Test Implementation
Source: [`tests/test_history_preserve.py:103-123`](file:///home/alexey/git/agent-branches/tests/test_history_preserve.py#L103-L123)

```python
def test_cli_history_preserve_success():
    from agent_branches.cli import main
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = pathlib.Path(tmp_dir)
        state_dir = tmp_path / "aplexer"
        output_dir = tmp_path / "archive"

        session_id = "cli-test-session"
        session_dir = state_dir / "sessions" / session_id
        session_dir.mkdir(parents=True)
        (session_dir / "history.bin").write_bytes(b"cli test buffer bytes")

        rc = main([
            "history", "preserve",
            "--session-id", session_id,
            "--output-dir", str(output_dir),
            "--state-dir", str(state_dir),
            "--json",
        ])
        assert rc == 0
        assert (output_dir / session_id / "history.bin").exists()
```

**Verification Assessment**:
- Verifies CLI argument invocation end-to-end through `main()`.
- Validates exit code `0` and physical creation of the archive target file.

---

## 3. Empirical Verification & Test Evidence

### 3.1 Targeted Test Execution
Command executed:
```bash
cd /home/alexey/git/agent-branches && PYTHONPATH=. pytest -v tests/test_history_preserve.py
```

Result:
```text
============================= test session starts ==============================
platform linux -- Python 3.12.3, pytest-9.1.1, pluggy-1.6.0 -- /usr/bin/python3
cachedir: .pytest_cache
rootdir: /home/alexey/git/agent-branches
plugins: anyio-4.12.1, opik-2.2.54
collecting ... collected 5 items

tests/test_history_preserve.py::test_preserve_session_history_success PASSED [ 20%]
tests/test_history_preserve.py::test_preserve_session_history_session_not_found PASSED [ 40%]
tests/test_history_preserve.py::test_preserve_session_history_budget_exceeded PASSED [ 60%]
tests/test_history_preserve.py::test_preserve_session_history_path_traversal_rejected PASSED [ 80%]
tests/test_history_preserve.py::test_cli_history_preserve_success PASSED [100%]

============================== 5 passed in 0.02s ===============================
```

### 3.2 Live Negative Edge Case Verification

1. **Non-Existent Session (`SessionNotFoundError`)**:
   - Exit Code: `1`
   - Formatted JSON:
     ```json
     {
       "error": "Session directory not found: .../sessions/missing",
       "status": "failed"
     }
     ```

2. **Budget Exceeded (`BudgetExceededError`)**:
   - Size: 100 bytes against `--max-bytes 50`
   - Exit Code: `1`
   - Formatted JSON:
     ```json
     {
       "error": "History size 100 bytes exceeds maximum allowed budget 50 bytes",
       "status": "failed"
     }
     ```

3. **Stderr Plaintext Output**:
   - Standard error output properly emitted to `sys.stderr` when `--json` is omitted:
     ```text
     Error: Session directory not found: ...
     ```
   - Exit Code: `1`

---

## 4. Security, Privacy & Integrity Guarantees

1. **Private Permissions**:
   Archive target directories are created with `0700` (`rwx------`) and files with `0600` (`rw-------`), preventing unauthorized local inspection.
2. **Strict Budget Ceiling**:
   Preservation immediately fails closed without allocating archive space if `history.bin` exceeds the configured or default budget.
3. **Path Traversal Defense**:
   Session identifiers containing traversal patterns (e.g. `../`) are rejected prior to any filesystem access.
4. **Scope Isolation**:
   Only target session data and generated metadata are captured; global message bus queues and adjacent session states are not accessed or copied.

---

## 5. Cross-Repository Isolation & Zero Contention Confirmation

- **Zero Contention**: `/home/alexey/git/cloudflare-agent-git` was inspected strictly in read-only mode and zero files were modified.
- **Repository Isolation**: All changes are confined to `/home/alexey/git/agent-branches` synchronized under `.local/git.lock`.
- **Quota Launcher Task Registry**:
  Confirmed state in `~/.config/agent-quota-launcher/state.db`:
  `t-branches-history-cli-c2898|completed-awaiting-review|t-branches-review-history-cli-c2898|2026-10-06 15:35:59`

---

## 6. Final Audit Verdict

### Final Verdict: **ACCEPTED**

Commit `f060c7e` provides a clean, robust, and safe CLI integration for bounded session history preservation. All unit tests pass, edge cases fail closed with appropriate exit codes and error messages, and repository isolation is strictly preserved.
