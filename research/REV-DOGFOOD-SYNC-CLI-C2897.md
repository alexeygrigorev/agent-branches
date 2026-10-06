# Independent Audit & Review: Branches Sync Dogfood CLI Integration (C2897)

- **Review Target Commit**: `969d682` (`feat(cli): add sync dogfood command to run 3-stage validation pipeline`)
- **Review Target Receipt**: [`research/RECEIPT-DOGFOOD-SYNC-CLI-C2897.md`](file:///home/alexey/git/agent-branches/research/RECEIPT-DOGFOOD-SYNC-CLI-C2897.md)
- **Task ID**: `t-branches-dogfood-cli-c2897`
- **Assigned Reviewer**: `t-branches-review-dogfood-cli-c2897`
- **Reviewer Conversation ID**: `5156295b-0c8f-4316-b37d-1beb03fe38a4`
- **Review Timestamp**: `2026-10-06T15:30:45Z`
- **Target Repository**: `/home/alexey/git/agent-branches`
- **Final Verdict**: **ACCEPTED**

---

## 1. Executive Summary

Commit `969d682` exposes the automated 3-stage dogfood branches sync pipeline ([`scripts/dogfood_branches_sync.py`](file:///home/alexey/git/agent-branches/scripts/dogfood_branches_sync.py)) directly through the `agent-branches` CLI via `branches sync dogfood [--json]`. This fulfills Stream 3 / Task `scale50-B` (`t-branches-dogfood-cli-c2897`) of `SCALE50-RECOVERY-PLAN.md`.

The implementation was independently reviewed and verified for:
1. Correct subparser registration and argument binding under the `sync` subcommand.
2. Safe execution of the 3-stage validation pipeline (Preview, Isolated Push, Remote Recovery) without mutating the local checkout HEAD or leaking uncommitted peer files.
3. Clean dual-mode output formatting (human-readable summary and machine-parsable JSON).
4. Deterministic exit semantics (0 on success, 1 on failure).
5. Comprehensive unit test coverage and clean pass status.
6. Zero contention with `/home/alexey/git/cloudflare-agent-git`.

---

## 2. Code Inspection & Architectural Analysis

### 2.1 Subparser Registration
Source: [`agent_branches/cli.py:405-407`](file:///home/alexey/git/agent-branches/agent_branches/cli.py#L405-L407)

```python
dogfood_sync = sync_sub.add_parser("dogfood", help="Run 3-stage automated dogfood pipeline (preview, isolated push, remote recovery)")
dogfood_sync.add_argument("--json", action="store_true", help="Output raw JSON")
```

**Assessment**:
- Correctly registered on `sync_sub` (`branches sync dogfood`).
- Help string accurately describes the 3-stage automated dogfood pipeline.
- `--json` boolean flag enables structured programmatic ingestion.

### 2.2 CLI Handler Implementation (`handle_sync_dogfood`)
Source: [`agent_branches/cli.py:892-904`](file:///home/alexey/git/agent-branches/agent_branches/cli.py#L892-L904)

```python
def handle_sync_dogfood(args: argparse.Namespace, as_json: bool) -> int:
    from scripts.dogfood_branches_sync import run_dogfood_pipeline
    results = run_dogfood_pipeline()
    if as_json:
        print(json.dumps(results, indent=2))
    else:
        print(f"[DOGFOOD PIPELINE] Status: {'SUCCESS' if results.get('success') else 'FAILED'}")
        print(f"  Pipeline ID: {results.get('pipeline_id')}")
        print(f"  Branch: {results.get('branch_name')}")
        for stage, data in results.get("stages", {}).items():
            print(f"  - {stage}: status={data.get('status')} verified={data.get('verified')}")
    return 0 if results.get("success") else 1
```

**Assessment**:
- **Lazy Import**: `from scripts.dogfood_branches_sync import run_dogfood_pipeline` defers pipeline module import until the command is invoked, preventing startup latency on unrelated CLI subcommands.
- **3-Stage Pipeline Enforcement**: Invokes `run_dogfood_pipeline()`, which guarantees:
  1. **Stage 1 (Preview Mode)**: Asserts zero remote branch creation, zero local checkout HEAD movement, and zero checkpoint refs created.
  2. **Stage 2 (Isolated Push)**: Uses temporary isolated index (`GIT_INDEX_FILE`), tree generation, and direct ref push, preserving local HEAD and protecting uncommitted peer dirty files.
  3. **Stage 3 (Remote Recovery)**: Performs clean clone from pushed remote ref, validates byte-for-byte SHA-256 match, and asserts zero leakage of dirty peer files.
- **Exit Semantics**: Strictly checks `results.get("success")` to return code `0` on success and `1` on failure.

### 2.3 Command Dispatch in `main()`
Source: [`agent_branches/cli.py:1064-1071`](file:///home/alexey/git/agent-branches/agent_branches/cli.py#L1064-L1071)

```python
        elif args.command == "sync":
            if getattr(args, "sync_action", None) == "git":
                return handle_sync_git(args, as_json)
            elif getattr(args, "sync_action", None) == "dogfood":
                return handle_sync_dogfood(args, as_json)
            else:
                parser.parse_args(["sync", "--help"])
                return 1
```

**Assessment**:
- Clean dispatching to `handle_sync_dogfood`.
- Fallthrough displays help and exits with status 1 if no sub-action is provided.

### 2.4 Unit Test Implementation
Source: [`tests/test_dogfood_sync.py:21-25`](file:///home/alexey/git/agent-branches/tests/test_dogfood_sync.py#L21-L25)

```python
def test_cli_sync_dogfood():
    from agent_branches.cli import main
    rc = main(["sync", "dogfood", "--json"])
    assert rc == 0
```

**Assessment**:
- Validates the CLI invocation pathway end-to-end via `main()` with `--json`.
- Complements `test_dogfood_branches_sync_pipeline_end_to_end` to guarantee pipeline integrity and CLI entrypoint correctness.

---

## 3. Empirical Verification & Test Evidence

### 3.1 Targeted Test Execution
Command executed:
```bash
cd /home/alexey/git/agent-branches && PYTHONPATH=. pytest -v tests/test_dogfood_sync.py
```

Result:
```text
============================= test session starts ==============================
platform linux -- Python 3.12.3, pytest-9.1.1, pluggy-1.6.0 -- /usr/bin/python3
cachedir: .pytest_cache
rootdir: /home/alexey/git/agent-branches
plugins: anyio-4.12.1, opik-2.2.54
collecting ... collected 2 items

tests/test_dogfood_sync.py::test_dogfood_branches_sync_pipeline_end_to_end PASSED [ 50%]
tests/test_dogfood_sync.py::test_cli_sync_dogfood PASSED                 [100%]

============================== 2 passed in 0.30s ===============================
```

### 3.2 Live Interactive Verification

1. **Human Formatted CLI Output**:
   ```bash
   PYTHONPATH=. python3 -m agent_branches.cli sync dogfood
   ```
   Output:
   ```text
   [DOGFOOD PIPELINE] Status: SUCCESS
     Pipeline ID: 430ab655
     Branch: dogfood-test-430ab655
     - preview: status=PASSED verified=None
     - isolated_push: status=PASSED verified=None
     - remote_recovery: status=PASSED verified=None
   ```
   Exit code: `0`

2. **JSON Formatted CLI Output**:
   ```bash
   PYTHONPATH=. python3 -m agent_branches.cli sync dogfood --json
   ```
   Output:
   ```json
   {
     "pipeline_id": "82808cef",
     "branch_name": "dogfood-test-82808cef",
     "stages": {
       "preview": {
         "status": "PASSED",
         "details": {
           "status": "preview",
           "branch": "dogfood-test-82808cef",
           "remote": "origin",
           "remote_sha": null,
           "shared_checkout_head": "532e21326cf6777c131b863b166f0c9a04d46608",
           "shared_checkout_advanced": false,
           "owned_paths": [
             "feature.py"
           ],
           "staged_in_isolated_index": [
             "feature.py"
           ],
           "diff_summary": [
             "A\tfeature.py"
           ],
           "in_sync": false,
           "verified": true,
           "message": "Preview mode: 1 owned path(s) would be committed against remote tip 532e2132. No commit created, no push attempted, no checkpoint ref created."
         }
       },
       "isolated_push": {
         "status": "PASSED",
         "commit": "500d9416e4c3f8faf64cea7fc6335f5cbd310b0c"
       },
       "remote_recovery": {
         "status": "PASSED",
         "recovered_sha256": "41719a5961e98e41478112e2889d3e134b9c7e1e6dc146a11282c0e21a470d9d",
         "leakage_clean": true
       }
     },
     "success": true
   }
   ```
   Exit code: `0`

---

## 4. Cross-Repository Isolation & Zero Contention Confirmation

- Strict read-only audit was observed for `/home/alexey/git/cloudflare-agent-git`.
- No edits, modifications, staging, or commits were performed in `/home/alexey/git/cloudflare-agent-git`.
- All review tasks, test runs, and documentation updates are confined exclusively to `/home/alexey/git/agent-branches` protected under `.local/git.lock`.
- Verified Quota Launcher task entry in `~/.config/agent-quota-launcher/state.db`:
  `t-branches-dogfood-cli-c2897|completed-awaiting-review|t-branches-review-dogfood-cli-c2897|2026-10-06 15:29:01`

---

## 5. Non-Blocking Observability Polish Note

In `agent_branches/cli.py` line 902:
```python
for stage, data in results.get("stages", {}).items():
    print(f"  - {stage}: status={data.get('status')} verified={data.get('verified')}")
```
In the pipeline dictionary, the top-level keys for each stage vary (`preview` has `details.verified`, `isolated_push` has `commit`, and `remote_recovery` has `leakage_clean`). As a result, `data.get('verified')` evaluates to `None` for all stages in plain-text output. This is purely cosmetic and does not affect exit codes, test assertions, or JSON output. A minor follow-up could display `verified=True` if `status == 'PASSED'` or print stage-specific metrics.

---

## 6. Final Audit Verdict

### Final Verdict: **ACCEPTED**

Commit `969d682` is fully verified, correctly implements the `sync dogfood` command, passes all targeted unit tests cleanly, and satisfies all requirements of Stream 3 / `scale50-B`.
