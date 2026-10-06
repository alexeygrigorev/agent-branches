"""Unit tests for production CLI entrypoint bus subcommands in agent-branches."""

from __future__ import annotations

import json
import stat
from pathlib import Path
import pytest

from agent_branches.cli import main
from agent_branches.bus import enroll_worker_startup, send_task_result


def test_cli_bus_enroll_and_permissions(tmp_path: Path, capsys):
    bus_store = tmp_path / "bus"
    bus_store.mkdir(parents=True)
    cred_file = tmp_path / "worker.cred.json"

    rc = main([
        "bus", "enroll",
        "--bus-store", str(bus_store),
        "--task-id", "t-cli-001",
        "--cred-path", str(cred_file),
        "--json",
    ])
    assert rc == 0
    out, _ = capsys.readouterr()
    res = json.loads(out)
    assert res["status"] == "enrolled_new"
    assert "branches-worker" in res["namespaced_id"]
    assert "-/t-cli-001" in res["namespaced_id"]
    assert cred_file.exists()
    assert stat.S_IMODE(cred_file.stat().st_mode) == 0o600


def test_cli_bus_send_and_receive(tmp_path: Path, capsys):
    bus_store = tmp_path / "bus"
    bus_store.mkdir(parents=True)
    worker_cred = tmp_path / "worker.cred.json"
    coord_cred = tmp_path / "coord.cred.json"

    # Enroll worker and coord
    main([
        "bus", "enroll",
        "--bus-store", str(bus_store),
        "--task-id", "worker-task",
        "--cred-path", str(worker_cred),
        "--agent-name", "worker",
        "--json",
    ])
    capsys.readouterr()

    main([
        "bus", "enroll",
        "--bus-store", str(bus_store),
        "--task-id", "coord-task",
        "--cred-path", str(coord_cred),
        "--agent-name", "coord",
        "--json",
    ])
    coord_out, _ = capsys.readouterr()
    coord_ident = json.loads(coord_out)["identity_id"]

    # Send from worker to coord
    rc_send = main([
        "bus", "send",
        "--bus-store", str(bus_store),
        "--cred-path", str(worker_cred),
        "--recipient-id", coord_ident,
        "--payload", json.dumps({"result": "task completed", "metrics": {"passed": True}}),
        "--json",
    ])
    assert rc_send == 0
    send_out, _ = capsys.readouterr()
    send_res = json.loads(send_out)
    assert send_res["status"] == "sent"
    msg_id = send_res["message_id"]

    # Receive at coord
    rc_recv = main([
        "bus", "receive",
        "--bus-store", str(bus_store),
        "--cred-path", str(coord_cred),
        "--json",
    ])
    assert rc_recv == 0
    recv_out, _ = capsys.readouterr()
    recv_res = json.loads(recv_out)
    assert recv_res["unread_count"] == 1
    assert recv_res["messages"][0]["message_id"] == msg_id
    assert recv_res["messages"][0]["body"]["result"] == "task completed"
