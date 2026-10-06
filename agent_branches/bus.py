"""AgentBus native startup enrollment, task result dispatch, and ReadAck integration for agent-branches.

Provides standalone and CLI-accessible methods to:
1. Enroll an independent sessionless worker identity at startup with 0600 disk credentials.
2. Dispatch validated task_result envelopes to AgentBus (passing pinned 12f9bde schema).
3. Read explicit recipient ReadAcks and receive coordinator task_ack envelopes with durable cursor persistence.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import stat
import sys
import time
from typing import Any, Dict, Optional

# Ensure agent-bus and agent-coordination are on sys.path if not installed
for extra_path in ("/home/alexey/git/agent-bus", "/home/alexey/git/agent-coordination"):
    if extra_path not in sys.path and os.path.exists(extra_path):
        sys.path.insert(0, extra_path)

try:
    from bus_envelope import validate_bus_envelope
except ImportError:
    validate_bus_envelope = None

try:
    from coordination.worker_bus import SessionlessWorkerBus
except ImportError:
    SessionlessWorkerBus = None


class AgentBusIntegrationError(Exception):
    """Raised when an AgentBus operation fails."""


def _ensure_imports():
    if SessionlessWorkerBus is None:
        raise AgentBusIntegrationError("coordination.worker_bus.SessionlessWorkerBus is not available")


def enroll_worker_startup(
    bus_store: str | Path,
    task_id: str,
    cred_path: str | Path,
    agent_name: str = "branches-worker",
    device_id: str = "hetzner-rmthz",
    project_id: str = "agent-branches",
) -> Dict[str, Any]:
    """Enroll a sessionless worker identity at startup and persist 0600 credentials.

    Enforces that session_id is None (renders as '-') to guarantee zero
    interactive aplexer session leakage.
    """
    _ensure_imports()
    store_path = Path(bus_store).resolve()
    cred_file = Path(cred_path).resolve()
    cred_file.parent.mkdir(parents=True, exist_ok=True)

    # If valid credentials already exist at path, load and return
    if cred_file.exists():
        try:
            worker = SessionlessWorkerBus.from_credentials(store=store_path, cred=cred_file)
            return {
                "status": "loaded_existing",
                "identity_id": worker.identity_id,
                "namespaced_id": worker.namespaced_id.render(),
                "cred_file": str(cred_file),
                "bus_store": str(store_path),
            }
        except Exception:
            pass  # Fall through to new registration if corrupt

    worker = SessionlessWorkerBus.register(
        store=store_path,
        agent_name=agent_name,
        device_id=device_id,
        project_id=project_id,
        task_id=task_id,
    )
    worker.save_credentials(cred_file)

    # Explicitly ensure 0600 permissions
    os.chmod(cred_file, 0o600)

    return {
        "status": "enrolled_new",
        "identity_id": worker.identity_id,
        "namespaced_id": worker.namespaced_id.render(),
        "cred_file": str(cred_file),
        "bus_store": str(store_path),
    }


def send_task_result(
    bus_store: str | Path,
    cred_path: str | Path,
    recipient_id: str,
    payload: Dict[str, Any] | str,
    kind: str = "task_result",
    idempotency_key: Optional[str] = None,
) -> Dict[str, Any]:
    """Send an authenticated task result envelope from disk credentials."""
    _ensure_imports()
    store_path = Path(bus_store).resolve()
    cred_file = Path(cred_path).resolve()

    if not cred_file.exists():
        raise AgentBusIntegrationError(f"Credential file not found: {cred_file}")

    worker = SessionlessWorkerBus.from_credentials(store=store_path, cred=cred_file)

    body_str = payload if isinstance(payload, str) else json.dumps(payload)
    if idempotency_key is None:
        idempotency_key = f"result-{worker.identity_id}-{int(time.time() * 1000)}"

    outcome = worker.send(
        recipient_id=recipient_id,
        body=body_str,
        kind=kind,
        idempotency_key=idempotency_key,
    )

    # Validate against pinned 12f9bde public schema if validator is present
    if validate_bus_envelope is not None:
        is_valid, err = validate_bus_envelope(outcome.message.to_public())
        if not is_valid:
            raise AgentBusIntegrationError(f"Envelope validation against 12f9bde failed: {err}")

    return {
        "status": "sent",
        "message_id": outcome.receipt.message_id,
        "idempotency_key": outcome.receipt.idempotency_key,
        "recipient_id": recipient_id,
        "sender_identity_id": worker.identity_id,
        "sender_namespaced_id": worker.namespaced_id.render(),
        "state": outcome.receipt.state.value,
        "sent_at": datetime.now(timezone.utc).isoformat(),
    }


def read_unread_messages(
    bus_store: str | Path,
    cred_path: str | Path,
) -> Dict[str, Any]:
    """Read unread messages using persistent cursor, avoiding duplicate re-delivery."""
    _ensure_imports()
    store_path = Path(bus_store).resolve()
    cred_file = Path(cred_path).resolve()

    worker = SessionlessWorkerBus.from_credentials(store=store_path, cred=cred_file)
    unread = worker.receive(unread_only=True)

    messages = []
    for msg in unread:
        body_obj = None
        try:
            body_obj = json.loads(msg.body)
        except Exception:
            body_obj = msg.body
        messages.append({
            "message_id": msg.message_id,
            "kind": msg.kind,
            "sender_id": msg.sender_id,
            "recipient_id": msg.recipient_id,
            "body": body_obj,
            "created_at": msg.created_at,
        })

    return {
        "status": "ok",
        "unread_count": len(unread),
        "messages": messages,
    }


def await_task_ack(
    bus_store: str | Path,
    cred_path: str | Path,
    expected_ack_for: str,
    timeout_sec: float = 30.0,
    poll_interval: float = 0.5,
) -> Dict[str, Any]:
    """Poll for an incoming task_ack message matching expected_ack_for message ID."""
    _ensure_imports()
    start_time = time.time()
    store_path = Path(bus_store).resolve()
    cred_file = Path(cred_path).resolve()

    worker = SessionlessWorkerBus.from_credentials(store=store_path, cred=cred_file)

    while time.time() - start_time < timeout_sec:
        unread = worker.receive(unread_only=True)
        for msg in unread:
            try:
                body = json.loads(msg.body)
                if isinstance(body, dict) and body.get("ack_for") == expected_ack_for:
                    read_ack = worker.ack(msg.message_id)
                    return {
                        "status": "ack_received",
                        "message_id": msg.message_id,
                        "ack_for": expected_ack_for,
                        "coordinator_verdict": body.get("coordinator_verdict"),
                        "payload": body,
                        "read_ack_state": read_ack.state.value,
                        "received_at": datetime.now(timezone.utc).isoformat(),
                    }
            except Exception:
                continue
        time.sleep(poll_interval)

    raise TimeoutError(f"Timed out after {timeout_sec}s waiting for task_ack for {expected_ack_for}")
