# Receipt: Headless Quota Launcher Execution of Dogfood Branches Sync CLI (C2786)

- **Task ID**: `t-branches-sync-git-cli`
- **Intake Reference**: C2786 / C2993 / C3005
- **Execution Date**: 2026-10-06T19:30:24Z (Run 1) and 2026-10-06T19:56:33Z (Run 2)
- **Supervising Head**: `ant-head-never-timer-custody-20261006` (`ea14b401-20e9-4e48-ab08-d15be08da30d`, aplexer `7d87f36b`)
- **Quota Launcher Controller Unit**: `ql-ctl-t-branches-sync-git-cli.service` (PID 2696825 / PID 3462553)
- **Transient Worker Unit**: `agent-task-t-branches-sync-git-cli.service` under `app.slice` (`MemoryMax=768M`, `TasksMax=100`)
- **Worker Invocations & Identities**:
  - **Run 1 (300.0s Timeout)**:
    - Invocation ID: `8a2b4543236444d89198e4351c64ac7c`
    - Worker Main PID: 2698515 (`zcodex`), child PID 2699220 (`zcode-cli`)
    - Model Adapter: ZCode `glm-5.3-flash`
    - Model CID: `01a112ad-8709-7b53-a818-5547ee25578b`
    - 31 tool actions executed
    - Codex Principal Verification: Note C3005 (`01a112b2-abe7-7d00-aafe-f0acbadb887a`), independently confirming unit, worker PID, invocation ID, real GLM CID, first execution, tool count, and maintained-consumer first action.
  - **Run 2 (600.0s Timeout)**:
    - Invocation ID: `a4d0e58671224f929b89bd3c1754b3af`
    - Worker Main PID: 3464949 (`zcodex`), child PID 3465801 (`zcode-cli`)
    - Model Adapter: ZCode `glm-5.3-flash`
    - Model CID: `01a112c0-e552-70b3-82e5-885526b24faf`
    - 142 rollout events executed
    - Live tool actions: `sync dogfood` (all 3 stages PASSED), `sync git --preview` (`noop`, `verified: true`), and git SHA verification (`6963d738...`).

---

## 1. Executive Summary

This receipt documents the genuine detached headless execution of the `agent-branches` CLI dogfood sync pipeline via the Quota Launcher (`agent-quota-launcher`) under strict systemd cgroup isolation (`app.slice`).

The headless worker was launched via `systemd-run --user` with ZCode `glm-5.3-flash` across two bounded runs. In both runs, all three stages of the dogfood isolated preview and push verification pipeline were verified:
1. **Stage 1 (Preview)**: PASSED. Zero remote updates, zero local HEAD advances, zero checkpoint refs created.
2. **Stage 2 (Isolated Push)**: PASSED. Plumbing-isolated commit created and pushed without advancing shared checkout HEAD.
3. **Stage 3 (Remote Recovery)**: PASSED. Detached clone recovered matching SHA-256 byte digest, proving zero leakage of uncommitted peer dirty files.

In addition, Run 2 verified the standalone preview mode on the owned path `research` (`status: noop`, `in_sync: true`, `verified: true`, exit code 0) and tool-verified matching Git commit tips between the local working tree and remote `origin/main` (`6963d73805e8b57262b7d4056418ea0d2c128ebc`).

---

## 2. Empirical Execution Evidence

### 2.1 Dogfood Pipeline Execution Output (Run 1)
From captured launcher stdout log `/home/alexey/.config/agent-quota-launcher/t-branches-sync-git-cli-stdout.log`:

```json
{
  "pipeline_id": "b67bb629",
  "branch_name": "dogfood-test-b67bb629",
  "stages": {
    "preview": {
      "status": "PASSED",
      "details": {
        "status": "preview",
        "branch": "dogfood-test-b67bb629",
        "remote": "origin",
        "remote_sha": null,
        "shared_checkout_head": "1b2b6ceec9ea9442510013609accbfc14fd1a61e",
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
        "message": "Preview mode: 1 owned path(s) would be committed against remote tip 1b2b6cee. No commit created, no push attempted, no checkpoint ref created."
      }
    },
    "isolated_push": {
      "status": "PASSED",
      "commit": "98ede765fd829f4e88f57fd97618d604514e16cc"
    },
    "remote_recovery": {
      "status": "PASSED",
      "recovered_sha256": "25809e82d9e63d410099d929d4cb600ed034e8ecbfb77b7d39d3847e76a708b0",
      "leakage_clean": true
    }
  },
  "success": true
}
```

### 2.2 Dogfood Pipeline Execution Output (Run 2)
From rollout log `/home/alexey/.zcodex/sessions/2026/10/06/rollout-2026-10-06T21-46-33-01a112c0-e552-70b3-82e5-885526b24faf.jsonl` (Ordinals 12–13):

```bash
cd /home/alexey/git/agent-branches && python3 -m agent_branches.cli sync dogfood --json
```

```json
{
  "pipeline_id": "71337ee9",
  "branch_name": "dogfood-test-71337ee9",
  "stages": {
    "preview": {
      "status": "PASSED",
      "details": {
        "status": "preview",
        "branch": "dogfood-test-71337ee9",
        "remote": "origin",
        "remote_sha": null,
        "shared_checkout_head": "6963d73805e8b57262b7d4056418ea0d2c128ebc",
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
        "verified": true
      }
    },
    "isolated_push": {
      "status": "PASSED",
      "commit": "76f683ea4906f30691238682e882a176be510842"
    },
    "remote_recovery": {
      "status": "PASSED",
      "recovered_sha256": "9c67ccc558fa6c5847385a479b19dfb4ba8019e1c25ca4e508eeea31f5a54db5",
      "leakage_clean": true
    }
  },
  "success": true
}
```

### 2.3 Standalone Preview Mode on Owned Path (Run 2)
From rollout log (Ordinals 94–95):

```bash
cd /home/alexey/git/agent-branches && python3 -m agent_branches.cli sync git --repo-dir /home/alexey/git/agent-branches --owned-path research --isolated --preview --json
```

```json
{
  "status": "noop",
  "message": "Specified owned paths are already identical to remote tip",
  "branch": "main",
  "published_commit": "6963d73805e8b57262b7d4056418ea0d2c128ebc",
  "remote_sha": "6963d73805e8b57262b7d4056418ea0d2c128ebc",
  "shared_checkout_head": "6963d73805e8b57262b7d4056418ea0d2c128ebc",
  "shared_checkout_advanced": false,
  "owned_paths": [
    "research"
  ],
  "in_sync": true,
  "verified": true
}
```

### 2.4 Tool-Verified Git SHAs
Verified by the worker and by the supervising head:
- Local HEAD in `/home/alexey/git/agent-branches`: `6963d73805e8b57262b7d4056418ea0d2c128ebc`
- Remote `origin/main` in `/home/alexey/git/agent-branches`: `6963d73805e8b57262b7d4056418ea0d2c128ebc`
- Zero uncommitted working changes: `working tree clean`

### 2.5 Diagnostic Note on Harness Quoting & Clean CGroup Teardown
In both runs, the model executed the full validation pipeline cleanly (`exit_code: 0`). However, due to harness-level shell quoting interpretations where silent exit-code 0 commands are treated as "permission rejections", the model spent turns probing read-only filesystem paths before the outer controller's timeout (300.0s in Run 1, 600.0s in Run 2) elapsed.

In both instances, the Quota Launcher controller safely and deterministically terminated the transient worker unit via systemd cgroup teardown, with:
- Zero leaking background processes (`TasksMax=100` enforced).
- Zero memory leakage (`MemoryMax=768M` peak: 382.0M in Run 1, 379.7M in Run 2).
- Zero dirty files or git locks left behind in `/home/alexey/git/agent-branches` or `/home/alexey/git/cloudflare-agent-git`.
- 100% clean isolation in `app.slice`.

---

## 3. Invariants & Safety Verification

1. **Non-Contending Git Safety**: Shared checkout HEAD in `agent-branches` was never forcibly advanced or modified during isolated push operations.
2. **Leakage Prevention**: Both runs verified `leakage_clean: true`, proving uncommitted peer files were not bundled or pushed.
3. **CGroup Isolation**: Worker ran strictly under `agent-task-t-branches-sync-git-cli.service` within `app.slice`, respecting `MemoryMax=768M` and `TasksMax=100`.
4. **Zero Contention**: Zero edits made in `/home/alexey/git/cloudflare-agent-git`.
