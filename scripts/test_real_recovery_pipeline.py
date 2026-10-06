"""End-to-end verification of coordinator-worker work assignment, execution, result, and reply pipeline using production AgentBus CLI entrypoints."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

# Paths
REPO_ROOT = Path("/home/alexey/git/agent-branches")
BUS_STORE = REPO_ROOT / ".local" / "bus_pipeline"
TMP_DIR = REPO_ROOT / ".local" / "tmp" / "t-branches-recovery-pipeline-c2852"
COORD_CRED = TMP_DIR / "coord.cred.json"
WORKER_CRED = TMP_DIR / "worker.cred.json"
RECOVERY_DEST = TMP_DIR / "recovered_clone"

# Clean prior run
if TMP_DIR.exists():
    shutil.rmtree(TMP_DIR)
TMP_DIR.mkdir(parents=True, exist_ok=True)
if BUS_STORE.exists():
    shutil.rmtree(BUS_STORE)
BUS_STORE.mkdir(parents=True, exist_ok=True)

BRANCHES_BIN = REPO_ROOT / "branches"

def run_cmd(args: list[str]) -> str:
    res = subprocess.run(args, cwd=REPO_ROOT, capture_output=True, text=True, check=True)
    return res.stdout.strip()

# 1. Enroll Coordinator
print("1. Enrolling Coordinator...")
coord_out = run_cmd([
    str(BRANCHES_BIN), "bus", "enroll",
    "--bus-store", str(BUS_STORE),
    "--task-id", "coord-c2852",
    "--cred-path", str(COORD_CRED),
    "--agent-name", "branches-coordinator",
    "--json",
])
coord_info = json.loads(coord_out)
coord_ident = coord_info["identity_id"]
print(f"Coordinator enrolled: {coord_info['namespaced_id']}")

# 2. Enroll Worker
print("2. Enrolling Recovery Worker...")
worker_out = run_cmd([
    str(BRANCHES_BIN), "bus", "enroll",
    "--bus-store", str(BUS_STORE),
    "--task-id", "t-branches-recovery-pipeline-c2852",
    "--cred-path", str(WORKER_CRED),
    "--agent-name", "recovery-worker",
    "--json",
])
worker_info = json.loads(worker_out)
worker_ident = worker_info["identity_id"]
print(f"Worker enrolled: {worker_info['namespaced_id']}")

# 3. Coordinator assigns work to Worker
print("3. Coordinator dispatching work assignment...")
assignment_payload = {
    "action": "git_recovery_verification",
    "target_repo": str(REPO_ROOT),
    "dest_dir": str(RECOVERY_DEST),
    "instructions": "Clone repository into clean destination, verify commit history and ./branches entrypoints",
}
send_assign_out = run_cmd([
    str(BRANCHES_BIN), "bus", "send",
    "--bus-store", str(BUS_STORE),
    "--cred-path", str(COORD_CRED),
    "--recipient-id", worker_ident,
    "--payload", json.dumps(assignment_payload),
    "--kind", "work_assignment",
    "--json",
])
assign_res = json.loads(send_assign_out)
assign_msg_id = assign_res["message_id"]
print(f"Work assignment dispatched: {assign_msg_id}")

# 4. Worker receives assignment
print("4. Worker receiving assignment...")
recv_out = run_cmd([
    str(BRANCHES_BIN), "bus", "receive",
    "--bus-store", str(BUS_STORE),
    "--cred-path", str(WORKER_CRED),
    "--json",
])
recv_res = json.loads(recv_out)
assert recv_res["unread_count"] == 1, f"Expected 1 assignment message, got {recv_res['unread_count']}"
assignment_msg = recv_res["messages"][0]
assert assignment_msg["message_id"] == assign_msg_id
print(f"Worker received assignment: {assignment_msg['body']['action']}")

# Explicitly acknowledge assignment message to advance worker cursor
run_cmd([
    str(BRANCHES_BIN), "bus", "ack",
    "--bus-store", str(BUS_STORE),
    "--cred-path", str(WORKER_CRED),
    "--message-id", assign_msg_id,
    "--json",
])
print(f"Worker acknowledged assignment: {assign_msg_id}")

# 5. Worker performs useful recovery work
print("5. Worker executing Git recovery...")
# Genuine ordinary git clone into disposable target directory
subprocess.run(
    ["git", "clone", str(REPO_ROOT), str(RECOVERY_DEST)],
    check=True,
    capture_output=True,
)
# Validate cloned repository
cloned_log = subprocess.run(
    ["git", "-C", str(RECOVERY_DEST), "log", "-n", "3", "--oneline"],
    check=True,
    capture_output=True,
    text=True,
).stdout.strip()
print(f"Cloned repository verified at HEAD:\n{cloned_log}")

# Verify entrypoint in cloned repository
cloned_branches = RECOVERY_DEST / "branches"
preview_res = subprocess.run(
    [str(cloned_branches), "sync", "git", "--preview", "--json"],
    cwd=RECOVERY_DEST,
    check=True,
    capture_output=True,
    text=True,
)
preview_json = json.loads(preview_res.stdout)
assert preview_json.get("status") == "preview", f"Preview failed: {preview_res.stdout}"

# Author result evidence
recovery_evidence = {
    "status": "success",
    "recovered_commit": cloned_log.splitlines()[0],
    "preview_verified": True,
    "clone_path": str(RECOVERY_DEST),
    "timestamp": time.time(),
}
evidence_file = TMP_DIR / "recovery_evidence.json"
evidence_file.write_text(json.dumps(recovery_evidence, indent=2))

# 6. Worker sends task result to Coordinator
print("6. Worker sending task result...")
send_result_out = run_cmd([
    str(BRANCHES_BIN), "bus", "send",
    "--bus-store", str(BUS_STORE),
    "--cred-path", str(WORKER_CRED),
    "--recipient-id", coord_ident,
    "--payload", json.dumps(recovery_evidence),
    "--kind", "task_result",
    "--json",
])
result_res = json.loads(send_result_out)
result_msg_id = result_res["message_id"]
print(f"Task result dispatched: {result_msg_id}")

# 7. Coordinator receives result and sends reply (task_ack)
print("7. Coordinator receiving result and sending task_ack reply...")
coord_recv_out = run_cmd([
    str(BRANCHES_BIN), "bus", "receive",
    "--bus-store", str(BUS_STORE),
    "--cred-path", str(COORD_CRED),
    "--json",
])
coord_recv = json.loads(coord_recv_out)
assert coord_recv["unread_count"] == 1
result_msg = coord_recv["messages"][0]
assert result_msg["message_id"] == result_msg_id

ack_payload = {
    "ack_for": result_msg_id,
    "coordinator_verdict": "ACCEPTED",
    "notes": "Verified ordinary git clone and entrypoint preview",
}
send_ack_out = run_cmd([
    str(BRANCHES_BIN), "bus", "send",
    "--bus-store", str(BUS_STORE),
    "--cred-path", str(COORD_CRED),
    "--recipient-id", worker_ident,
    "--payload", json.dumps(ack_payload),
    "--kind", "task_ack",
    "--json",
])
ack_res = json.loads(send_ack_out)
print(f"Coordinator task_ack dispatched: {ack_res['message_id']}")

# 8. Worker awaits coordinator reply before exit
print("8. Worker awaiting coordinator reply...")
worker_await_out = run_cmd([
    str(BRANCHES_BIN), "bus", "await-ack",
    "--bus-store", str(BUS_STORE),
    "--cred-path", str(WORKER_CRED),
    "--expected-ack-for", result_msg_id,
    "--timeout", "10",
    "--json",
])
await_res = json.loads(worker_await_out)
assert await_res["status"] == "ack_received"
assert await_res["coordinator_verdict"] == "ACCEPTED"
print(f"Worker received coordinator reply: {await_res['coordinator_verdict']}")

# 9. Verify cursor persistence: worker unread is now 0
post_recv = json.loads(run_cmd([
    str(BRANCHES_BIN), "bus", "receive",
    "--bus-store", str(BUS_STORE),
    "--cred-path", str(WORKER_CRED),
    "--json",
]))
assert post_recv["unread_count"] == 0, f"Expected 0 unread, got {post_recv['unread_count']}"

summary = {
    "status": "passed",
    "pipeline": "work_assignment -> git_recovery -> task_result -> task_ack -> await_reply",
    "assign_msg_id": assign_msg_id,
    "result_msg_id": result_msg_id,
    "coordinator_reply_verdict": await_res["coordinator_verdict"],
    "recovery_evidence": recovery_evidence,
}
summary_file = TMP_DIR / "pipeline_summary.json"
summary_file.write_text(json.dumps(summary, indent=2))
print("PIPELINE_SUCCESS")
print(json.dumps(summary, indent=2))
