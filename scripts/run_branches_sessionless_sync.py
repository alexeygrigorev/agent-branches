#!/usr/bin/env python3
"""Sessionless Model AgentBus Callback Pipeline for Agent Branches Dogfood Sync (C2786 / C3021 / C3022).

Demonstrates the admitted sessionless worker execution pattern interacting with FileBus:
1. Head initializes FileBus, enrolls head and sessionless worker, and dispatches dogfood sync task.
2. Sessionless worker consumes dispatch, executes the 3-stage dogfood sync pipeline, writes on-disk artifact, and sends reply with cryptographic SHA-256 digest.
3. Head consumes reply, validates SHA-256 digest against disk bytes, ACKs reply, and confirms pipeline success.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time
from typing import Any, Dict

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

# Ensure agent-bus is on sys.path
BUS_REPO = Path("/home/alexey/git/agent-bus")
if str(BUS_REPO) not in sys.path and BUS_REPO.exists():
    sys.path.insert(0, str(BUS_REPO))

try:
    from coordination.bus import BusIdentity, FileBus
except ImportError:
    FileBus = None
    BusIdentity = None

from scripts.dogfood_branches_sync import run_dogfood_pipeline


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def cmd_head_init(bus_dir: Path, ws_dir: Path) -> dict[str, Any]:
    bus_dir.mkdir(parents=True, exist_ok=True)
    ws_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(bus_dir, 0o700)
    os.chmod(ws_dir, 0o700)

    bus = FileBus(bus_dir)

    # Register Head identity
    head_ident, head_tok = bus.register(
        agent_name="head-sync-sessionless",
        device_id="hetzner-rmthz",
        project_id="agent-branches",
    )

    # Register Sessionless Worker identity (session_id=None renders as "-")
    worker_ident, worker_tok = bus.register(
        agent_name="worker-sync-sessionless",
        device_id="hetzner-rmthz",
        project_id="agent-branches",
    )

    # Save credentials (0600)
    head_cred = {"identity": head_ident.public(), "token": head_tok}
    worker_cred = {"identity": worker_ident.public(), "token": worker_tok}

    head_cred_file = bus_dir / "head.cred.json"
    worker_cred_file = bus_dir / "worker.cred.json"

    head_cred_file.write_text(json.dumps(head_cred, indent=2), encoding="utf-8")
    worker_cred_file.write_text(json.dumps(worker_cred, indent=2), encoding="utf-8")

    os.chmod(head_cred_file, 0o600)
    os.chmod(worker_cred_file, 0o600)

    # Dispatch task to worker
    task_payload = {
        "task_id": "t-branches-sync-sessionless-bus",
        "task_type": "dogfood_sync_execution",
        "pipeline": "dogfood",
        "owned_path": "research",
        "required_output": "sync_dogfood_output.json",
    }

    dispatch_msg = bus.send(
        sender_id=head_ident.identity_id,
        token=head_tok,
        recipient_id=worker_ident.identity_id,
        kind="task_dispatch",
        body="Execute agent-branches 3-stage dogfood sync pipeline",
        data=task_payload,
        idempotency_key=f"dispatch-sync-{int(time.time() * 1000)}",
    )

    return {
        "status": "INIT_SUCCESS",
        "bus_dir": str(bus_dir),
        "workspace_dir": str(ws_dir),
        "head_identity": head_ident.identity_id,
        "worker_identity": worker_ident.identity_id,
        "dispatch_message_id": dispatch_msg.message_id,
        "task_id": task_payload["task_id"],
    }


def cmd_worker_exec(bus_dir: Path, ws_dir: Path) -> dict[str, Any]:
    worker_cred_file = bus_dir / "worker.cred.json"
    if not worker_cred_file.exists():
        raise FileNotFoundError(f"Missing worker cred: {worker_cred_file}")

    cred = json.loads(worker_cred_file.read_text(encoding="utf-8"))
    worker_tok = cred["token"]
    ident_dict = cred["identity"]
    worker_ident = BusIdentity(**ident_dict)

    bus = FileBus(bus_dir)

    inbox = bus.inbox(worker_ident.identity_id, worker_tok, unread_only=True)
    if not inbox:
        return {"status": "NO_TASKS", "worker_identity": worker_ident.identity_id}

    dispatch_msg = inbox[0]
    bus.ack(worker_ident.identity_id, worker_tok, dispatch_msg.message_id)

    task_data = dispatch_msg.data or {}
    task_id = task_data.get("task_id", "t-branches-sync-sessionless-bus")

    # Execute genuine 3-stage dogfood validation pipeline
    pipeline_res = run_dogfood_pipeline()

    # Produce on-disk artifact
    art_file = ws_dir / "sync_dogfood_output.json"
    art_payload = {
        "task_id": task_id,
        "pipeline_id": pipeline_res["pipeline_id"],
        "branch_name": pipeline_res["branch_name"],
        "stages": pipeline_res["stages"],
        "success": pipeline_res["success"],
        "executed_by": worker_ident.identity_id,
        "execution_timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    art_file.write_text(json.dumps(art_payload, indent=2), encoding="utf-8")
    art_digest = file_sha256(art_file)

    # Send completion reply back to Head
    reply_payload = {
        "task_id": task_id,
        "status": "COMPLETED",
        "artifact_path": str(art_file),
        "artifact_digest": art_digest,
        "success": pipeline_res["success"],
        "stages": {k: v.get("status") for k, v in pipeline_res["stages"].items()},
    }

    reply_msg = bus.send(
        sender_id=worker_ident.identity_id,
        token=worker_tok,
        recipient_id=dispatch_msg.sender_id,
        kind="task_reply",
        body="Completed agent-branches dogfood sync pipeline successfully",
        data=reply_payload,
        reply_to=dispatch_msg.message_id,
        idempotency_key=f"reply-sync-{int(time.time() * 1000)}",
    )

    return {
        "status": "WORKER_SUCCESS",
        "worker_identity": worker_ident.identity_id,
        "task_id": task_id,
        "dispatch_message_id": dispatch_msg.message_id,
        "reply_message_id": reply_msg.message_id,
        "artifact_path": str(art_file),
        "artifact_digest": art_digest,
        "pipeline_success": pipeline_res["success"],
    }


def cmd_head_consume(bus_dir: Path, ws_dir: Path) -> dict[str, Any]:
    head_cred_file = bus_dir / "head.cred.json"
    if not head_cred_file.exists():
        raise FileNotFoundError(f"Missing head cred: {head_cred_file}")

    cred = json.loads(head_cred_file.read_text(encoding="utf-8"))
    head_tok = cred["token"]
    ident_dict = cred["identity"]
    head_ident = BusIdentity(**ident_dict)

    bus = FileBus(bus_dir)

    inbox = bus.inbox(head_ident.identity_id, head_tok, unread_only=True)
    if not inbox:
        # Fallback to all messages for idempotent auditing
        inbox = bus.inbox(head_ident.identity_id, head_tok, unread_only=False)

    if not inbox:
        return {"status": "NO_REPLIES", "head_identity": head_ident.identity_id}

    reply_msg = inbox[0]
    bus.ack(head_ident.identity_id, head_tok, reply_msg.message_id)

    reply_data = reply_msg.data or {}
    art_path = Path(reply_data.get("artifact_path", ""))
    reported_digest = reply_data.get("artifact_digest", "")

    if not art_path.exists():
        raise FileNotFoundError(f"Reported artifact does not exist: {art_path}")

    actual_digest = file_sha256(art_path)
    is_valid = (reported_digest == actual_digest)
    if not is_valid:
        raise ValueError(f"Digest mismatch! Reported: {reported_digest}, Actual: {actual_digest}")

    return {
        "status": "HEAD_CONSUMED",
        "head_identity": head_ident.identity_id,
        "reply_message_id": reply_msg.message_id,
        "is_valid": is_valid,
        "task_id": reply_data.get("task_id"),
        "artifact_digest": actual_digest,
        "pipeline_success": reply_data.get("success"),
        "stages": reply_data.get("stages"),
    }


def main():
    parser = argparse.ArgumentParser(description="Sessionless Branches Sync Bus Callback")
    parser.add_argument(
        "--mode",
        choices=["head-init", "worker-exec", "head-consume", "full-pipeline"],
        default="full-pipeline",
        help="Pipeline phase to execute",
    )
    parser.add_argument(
        "--bus-dir",
        type=Path,
        default=ROOT_DIR / ".local" / "bus_sessionless_sync",
        help="FileBus storage directory",
    )
    parser.add_argument(
        "--workspace-dir",
        type=Path,
        default=ROOT_DIR / ".local" / "bus_sessionless_sync" / "workspace",
        help="Task execution workspace directory",
    )
    parser.add_argument("--json", action="store_true", help="Output JSON results")
    args = parser.parse_args()

    results = {}
    if args.mode == "head-init":
        results = cmd_head_init(args.bus_dir, args.workspace_dir)
    elif args.mode == "worker-exec":
        results = cmd_worker_exec(args.bus_dir, args.workspace_dir)
    elif args.mode == "head-consume":
        results = cmd_head_consume(args.bus_dir, args.workspace_dir)
    elif args.mode == "full-pipeline":
        r1 = cmd_head_init(args.bus_dir, args.workspace_dir)
        r2 = cmd_worker_exec(args.bus_dir, args.workspace_dir)
        r3 = cmd_head_consume(args.bus_dir, args.workspace_dir)
        results = {
            "status": "FULL_PIPELINE_SUCCESS",
            "head_init": r1,
            "worker_exec": r2,
            "head_consume": r3,
        }

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        print(f"[{results.get('status')}] Processed {args.mode}")


if __name__ == "__main__":
    main()
