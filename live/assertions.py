#!/usr/bin/env python3
"""Pass/fail assertions for the Agent Branches live run (run 3, CONTRACT 0.1.2).

phase1: radar verdicts vs the DESIGNED overlap matrix, /checks receipt (typed
        contract-"0.1" payload posted verbatim), /status pair views + warnings.
final:  everything in phase1 (against the pass-2 vector) + stale-409 + per-task
        intent/base_sha + UI badge checks + evidence files.
Prints one PASS/FAIL line per assertion; exits nonzero if any FAIL.

Run-3 semantics (run-2 gaps closed):
- T1-T3 is a REAL textual overlap (G8): asserted as conflict+textual; nothing
  "expected clean" accepts a conflict.
- Warnings are counted PER CONFLICTING PAIR across newly-created AND
  pre-existing active warnings (the coordinator dedupes by pair+headsAtIssue),
  never "newly-created only".
- The T2-T3 test conflict must surface per-pair coverage.tests_collected > 0
  in /status, and the UI's own pair-status logic must badge it "Conflict".
"""
import argparse
import json
import os
import re
import subprocess
import sys

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{detail}]" if detail else ""))


def write_result(path, phase):
    """Machine-readable run result (live/evidence/run-N/result.json)."""
    payload = {
        "phase": phase,
        "passed": sum(1 for _, ok, _ in results if ok),
        "total": len(results),
        "allPassed": all(ok for _, ok, _ in results),
        "assertions": [{"name": n, "ok": ok, "detail": d} for n, ok, d in results],
    }
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)


def load(path):
    with open(path) as f:
        return json.load(f)


def radar_pairs(evidence, prefix):
    payload = load(os.path.join(evidence, f"{prefix}-l1.json"))
    out = {}
    for r in payload["results"]:
        a, b = sorted(r["pair"])
        out[(a, b)] = r
    return payload, out


def check_vector_status(status, state, agents, label):
    heads = status["heads"]
    for t in agents:
        want = open(os.path.join(state, f"{t}.sha")).read().strip()
        check(f"{label}: head vector {t} == pushed sha",
              heads.get(agents[t]) == want, f"{heads.get(agents[t])} vs {want[:8]}")


def warnings_for(status, id_a, id_b):
    a, b = sorted([id_a, id_b])
    return [w for w in status["warnings"]
            if w["status"] == "active" and sorted(w["pair"]) == [a, b]]


def pair_view(status, id_a, id_b):
    a, b = sorted([id_a, id_b])
    for view in status.get("pairs", []):
        if sorted(view["pair"]) == [a, b]:
            return view
    return None


def expected_intents(tasks_md):
    """The per-task intent strings, distilled from demo-target/TASKS.md exactly
    like run-demo.sh's task_intent() does (single-line tests-to-add capture)."""
    text = open(tasks_md, encoding="utf-8").read()
    intents = {}
    for tid in ("t1", "t2", "t3"):
        T = tid.upper()
        head = re.search(rf"^## {T} — (.+)$", text, re.M)
        title = head.group(1).strip() if head else ""
        tests = re.search(rf"^## {T} —.*?^Tests to add: ([^\n]*)", text, re.S | re.M)
        tests_line = tests.group(1).strip() if tests else ""
        intent = f"{T}: {title}"
        if tests_line:
            intent += f" — tests to add: {tests_line}"
        intents[tid] = intent
    return intents


def check_task_setup(tasks, evidence, state, live, label):
    """Run-3: each task record carries its intent (from TASKS.md) and the
    canonical base_sha, and /status agents surface both (UI cards)."""
    setup = load(os.path.join(evidence, "setup.json"))
    seed = setup.get("seedCommit")
    intents = expected_intents(os.path.join(live, "..", "demo-target", "TASKS.md"))
    for t in ("t1", "t2", "t3"):
        task = load(os.path.join(state, f"task-{t}.json"))
        check(f"{label}: {t} intent recorded (from TASKS.md)",
              task.get("intent") == intents[t],
              (task.get("intent") or "null")[:80])
        check(f"{label}: {t} base_sha == canonical seed commit",
              task.get("base_sha") == seed,
              f"{str(task.get('base_sha'))[:8]} vs {str(seed)[:8]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("phase", choices=["phase1", "final"])
    ap.add_argument("--live", required=True)
    ap.add_argument("--evidence", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--status", default="status.json", help="status JSON filename inside --evidence")
    ap.add_argument("--result-out", default=None, help="write machine-readable result JSON here")
    args = ap.parse_args()

    live, ev, st = args.live, args.evidence, args.state
    tasks = {t: load(os.path.join(st, f"task-{t}.json")) for t in ("t1", "t2", "t3")}
    agents = {t: tasks[t]["agentId"] for t in tasks}
    radar_prefix = "radar2" if args.phase == "final" else "radar1"
    status = load(os.path.join(ev, args.status))

    # --- radar verdicts vs the DESIGNED overlap matrix -----------------------
    # demo-target's designed matrix (G8-corrected): THREE conflicts —
    # T1+T2 textual (same create() record literal), T1+T3 textual (both insert
    # routes at the same anchor in src/worker.js — real, reproduced with
    # git merge-tree), T2+T3 test/semantic (bulk endpoint on the removed
    # positional create contract).
    payload, pairs = radar_pairs(ev, radar_prefix)
    check(f"{radar_prefix}: contract-0.1 typed payload has 3 pair results",
          payload.get("contract") == "0.1" and len(payload["results"]) == 3,
          f"n={len(payload.get('results', []))}")

    p12 = pairs.get(tuple(sorted([agents["t1"], agents["t2"]])))
    check("T1-T2 verdict: conflict (textual)",
          p12 and p12["status"] == "conflict" and p12.get("kind") == "textual",
          f"status={p12 and p12['status']} kind={p12 and p12.get('kind')}" if p12 else "pair missing")

    p23 = pairs.get(tuple(sorted([agents["t2"], agents["t3"]])))
    check("T2-T3 verdict: conflict (test)",
          p23 and p23["status"] == "conflict" and p23.get("kind") == "test",
          f"status={p23 and p23['status']} kind={p23 and p23.get('kind')}" if p23 else "pair missing")

    p13 = pairs.get(tuple(sorted([agents["t1"], agents["t3"]])))
    check("T1-T3 verdict: expected conflict (textual, real overlap)",
          p13 and p13["status"] == "conflict" and p13.get("kind") == "textual",
          f"status={p13 and p13['status']} kind={p13 and p13.get('kind')}" if p13 else "pair missing")

    # --- /checks receipt (typed 0.1 payload accepted verbatim; G4/G5) --------
    receipt = load(os.path.join(ev, "checks2-receipt.json" if radar_prefix == "radar2" else "checks1-receipt.json"))
    n_conflicts = sum(1 for r in payload["results"] if r["status"] == "conflict")
    created = receipt.get("createdWarnings", [])
    # G-gap fix: warnings are counted PER conflicting pair across new + existing
    # ACTIVE warnings (the coordinator dedupes by pair+headsAtIssue, so an
    # unchanged pair legitimately reuses its existing warning and creates none).
    conflict_pairs = {tuple(sorted(r["pair"])) for r in payload["results"]
                      if r["status"] == "conflict"}
    created_pairs = {tuple(sorted(w["pair"])) for w in created}
    active_pairs = {tuple(sorted(w["pair"])) for w in status.get("warnings", [])
                    if w.get("status") == "active"}
    per_pair_counts = {pair: len(active_pairs & {pair}) for pair in conflict_pairs}
    check("/checks receipt: not stale; typed payload accepted verbatim",
          receipt.get("stale") is False and receipt.get("accepted") == len(payload["results"]),
          f"stale={receipt.get('stale')} accepted={receipt.get('accepted')} "
          f"results={len(payload['results'])}")
    check("/checks receipt: every conflicted pair has an ACTIVE warning (new or existing, dedup)",
          conflict_pairs <= active_pairs,
          f"conflictPairs={len(conflict_pairs)} covered={len(conflict_pairs & active_pairs)} "
          f"perPair={per_pair_counts}")
    check("/checks receipt: created warnings only for conflicted pairs, never more than conflicts",
          created_pairs <= conflict_pairs and len(created) <= n_conflicts,
          f"createdWarnings={len(created)} pairs={sorted(p[0] + '|' + p[1] for p in created_pairs)} "
          f"conflicts={n_conflicts}")

    # --- status: pair views (fresh at current heads) -------------------------
    check_vector_status(status, st, agents, "status")
    v12 = pair_view(status, agents["t1"], agents["t2"])
    check("status pair view T1-T2: conflict (textual) at current heads",
          v12 and v12["status"] == "conflict" and v12.get("kind") == "textual" and not v12.get("stale"),
          f"status={v12 and v12['status']} kind={v12 and v12.get('kind')} stale={v12 and v12.get('stale')}"
          if v12 else "pair view missing")
    v13 = pair_view(status, agents["t1"], agents["t3"])
    check("status pair view T1-T3: conflict (textual) at current heads",
          v13 and v13["status"] == "conflict" and v13.get("kind") == "textual" and not v13.get("stale"),
          f"status={v13 and v13['status']} kind={v13 and v13.get('kind')} stale={v13 and v13.get('stale')}"
          if v13 else "pair view missing")
    v23 = pair_view(status, agents["t2"], agents["t3"])
    check("status pair view T2-T3: conflict (test) at current heads",
          v23 and v23["status"] == "conflict" and v23.get("kind") == "test" and not v23.get("stale"),
          f"status={v23 and v23['status']} kind={v23 and v23.get('kind')} stale={v23 and v23.get('stale')}"
          if v23 else "pair view missing")
    collected = ((v23 or {}).get("coverage") or {}).get("tests_collected")
    check("status pair view T2-T3: per-pair tests_collected > 0",
          isinstance(collected, (int, float)) and collected > 0,
          f"coverage={v23 and v23.get('coverage')}")
    check("status: active warning for T1-T2", len(warnings_for(status, agents["t1"], agents["t2"])) >= 1)
    check("status: active warning for T2-T3", len(warnings_for(status, agents["t2"], agents["t3"])) >= 1)
    check("status: active warning for T1-T3", len(warnings_for(status, agents["t1"], agents["t3"])) >= 1)
    radar_kinds = ("textual", "test", "merge-conflict", "conflict")
    n_radar = sum(1 for w in status.get("warnings", [])
                  if w.get("status") == "active" and w.get("reason") in radar_kinds)
    check("status: active warnings carry radar conflict reasons", n_radar >= 3,
          f"{n_radar} radar-kinded warnings (reason is the radar kind per CONTRACT v0.1.2)")

    check_task_setup(tasks, ev, st, live, "task record")

    if args.phase == "final":
        code409 = open(os.path.join(st, "stale409.code")).read().strip()
        check("stale check after new push rejected 409", code409 == "409", f"got {code409}")
        stale_body = load(os.path.join(ev, "stale-409.json"))
        # The worker's 409 body is {error, currentHeads}: the moved agent is the
        # one whose current head differs from the replayed vector.
        replayed_vector = radar_pairs(ev, "radar1")[0].get("vector", {})
        cur = stale_body.get("currentHeads") or {}
        t1_moved = cur.get(agents["t1"]) not in (None, replayed_vector.get(agents["t1"]))
        check("409 body names the moved agent (t1)", t1_moved,
              f"replayed t1={replayed_vector.get(agents['t1'], '?')[:8]} "
              f"current={cur.get(agents['t1'], 'missing')[:8] if cur.get(agents['t1']) else cur.get(agents['t1'])}")

        # --- UI: badges come from the UI's own pair-status logic -------------
        ui_pairs = load(os.path.join(ev, "ui-pairs.json"))
        pair_keys = {
            "t1-t2": "|".join(sorted([agents["t1"], agents["t2"]])),
            "t1-t3": "|".join(sorted([agents["t1"], agents["t3"]])),
            "t2-t3": "|".join(sorted([agents["t2"], agents["t3"]])),
        }
        for label, key in pair_keys.items():
            badge = ui_pairs.get(key)
            check(f"UI badge {label}: shows Conflict (not Clean/Not checked)",
                  badge == "conflict", f"badge={badge}")

        # status agents must surface intent + baseSha for the UI cards
        by_agent = {a["agentId"]: a for a in status.get("agents", [])}
        intents = expected_intents(os.path.join(live, "..", "demo-target", "TASKS.md"))
        seed = load(os.path.join(ev, "setup.json")).get("seedCommit")
        for t in ("t1", "t2", "t3"):
            ag = by_agent.get(agents[t], {})
            check(f"status agent {t}: intent + baseSha exposed (UI cards)",
                  ag.get("intent") == intents[t] and ag.get("baseSha") == seed,
                  f"intent={(ag.get('intent') or 'null')[:60]} baseSha={str(ag.get('baseSha'))[:8]}")

        check("evidence: UI index screenshot exists",
              os.path.exists(os.path.join(ev, "ui-index.png")) and
              os.path.getsize(os.path.join(ev, "ui-index.png")) > 10_000)
        task2_id = open(os.path.join(st, "task2.taskid")).read().strip()
        task_png = os.path.join(ev, f"ui-task-{task2_id}.png")
        check("evidence: UI task-page screenshot exists",
              os.path.exists(task_png) and os.path.getsize(task_png) > 10_000,
              os.path.basename(task_png))
        check("evidence: /status JSON saved", os.path.exists(os.path.join(ev, "status.json")))
        check("evidence: no *.posted.json down-conversion shim",
              not [f for f in os.listdir(ev) if f.endswith(".posted.json")],
              "typed payload posted verbatim (G4/G5 closed)")

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed ({args.phase})")
    if args.result_out:
        write_result(args.result_out, args.phase)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
