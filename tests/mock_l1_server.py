"""Offline Mock L1 Coordinator Server for Agent Branches testing.

Implements the exact HTTP routes:
- POST /tasks
- POST /events/push
- GET /status
- GET /tasks/<id>
- POST /warnings/<id>/ack
- POST /checks (CONTRACT v0.1)

Bearer-token simulation:
- expected_admin_token guards POST /tasks; expected_runner_token guards POST /checks.
- When expected_admin_token is configured, POST /events/push enforces the
  proto mutating ladder (C1518, muse-r46 AUTH, decideMutatingAuth narrowed
  to the pushing agent): admin or the pushing agent's own task token ->
  200, valid token of a DIFFERENT agent -> 403, anonymous/malformed/
  runner/revoked/unknown -> 401. No sidecar bearer is simulated.
- When expected_admin_token is configured, GET /tasks/<id> enforces the
  proto/auth-reads owner-or-admin read ladder (C1462/C1499, matching
  prototype/src/core/auth.ts decideReadAuth narrowed to the task owner):
  admin or owning agent task token -> 200, valid foreign agent token -> 403,
  everything else (anonymous/malformed, runner, revoked, unknown) -> 401
  shared body. RUNNER_TOKEN is a read credential on unnarrowed reads only
  (/status), so on a narrowed task read it is 401. The default
  unconfigured mock keeps legacy open reads for existing fixtures.
- admin_token_expires_at / runner_token_expires_at (epoch seconds) simulate token
  expiry: a correct token past its expiry is rejected with HTTP 401 and an
  {"error": "token_expired", "expires_at": ...} payload.
- revoke_token(token) simulates revocation: subsequent requests presenting that
  token are rejected with HTTP 403 and an {"error": "token_revoked",
  "revoked_at": ...} payload (revocation is checked before expiry).
"""

import argparse
import datetime
import http.server
import json
import re
import socketserver
import sys
import threading
import time
import urllib.parse
from typing import Any, Dict, List, Optional, Set, Tuple


class MockStaleVectorError(Exception):
    """Raised when head vector is stale."""
    pass


class MockCoordinatorState:
    """Thread-safe in-memory state for mock L1 coordinator."""

    def __init__(
        self,
        expected_admin_token: Optional[str] = None,
        expected_runner_token: Optional[str] = None,
        admin_token_expires_at: Optional[float] = None,
        runner_token_expires_at: Optional[float] = None,
        token_wire_object: bool = True,
    ):
        self.lock = threading.Lock()
        # C1509: True = POST /tasks answers with the real coordinator wire
        # shape (token {scope, expiresAt, plaintext}); False = legacy flat
        # plaintext string. The stored record always keeps the plaintext
        # string so bearer checks compare strings.
        self.token_wire_object = token_wire_object
        # Authorization header as last presented on an authed route
        # (test observability: lets tests assert the exact bearer header
        # sent, on GET /tasks/<id> and POST /events/push alike).
        self.last_authorization: Optional[str] = None
        self.seq = 0
        self.tasks: Dict[str, Dict[str, Any]] = {}
        self.agents: Dict[str, Dict[str, Any]] = {}
        self.warnings: Dict[str, Dict[str, Any]] = {}
        self.seen_pushes: Set[Tuple[str, str]] = set()
        self.radar_log: List[Dict[str, Any]] = []
        self.canonical_name = "agent-branches-canonical"
        self.canonical_remote = "https://git.cloudflare.local/canonical.git"
        self.expected_admin_token = expected_admin_token
        self.expected_runner_token = expected_runner_token
        # Token expiry as epoch seconds (None = never expires). A correct token
        # presented at or after its expiry is rejected with 401 token_expired.
        self.admin_token_expires_at = admin_token_expires_at
        self.runner_token_expires_at = runner_token_expires_at
        # token -> revoked_at ISO timestamp; revoked tokens are rejected with 403.
        self.revoked_tokens: Dict[str, str] = {}

    def revoke_token(self, token: str, revoked_at: Optional[str] = None) -> str:
        """Mark a bearer token as revoked; returns the revocation timestamp."""
        ts = revoked_at or datetime.datetime.now(datetime.timezone.utc).isoformat()
        with self.lock:
            self.revoked_tokens[token] = ts
        return ts

    def check_bearer_token(
        self,
        auth_header: str,
        expected_token: str,
        expires_at: Optional[float],
        kind: str,
    ) -> Optional[Tuple[int, Dict[str, Any]]]:
        """Validate a presented bearer token.

        Returns (http_status, error_payload) when the request must be rejected
        (revocation, missing/invalid token, expiry — in that order), else None.
        """
        with self.lock:
            match = re.match(r"^Bearer\s+(\S+)$", (auth_header or "").strip())
            presented = match.group(1) if match else None

            if presented is not None and presented in self.revoked_tokens:
                revoked_at = self.revoked_tokens[presented]
                return 403, {
                    "error": "token_revoked",
                    "message": f"{kind} bearer token revoked at {revoked_at}",
                    "revoked_at": revoked_at,
                }

            if presented is None or presented != expected_token:
                return 401, {
                    "error": "unauthorized: missing or invalid bearer token",
                }

            if expires_at is not None and time.time() >= expires_at:
                expires_iso = datetime.datetime.fromtimestamp(
                    expires_at, datetime.timezone.utc
                ).isoformat()
                return 401, {
                    "error": "token_expired",
                    "message": f"{kind} bearer token expired at {expires_iso}",
                    "expires_at": expires_iso,
                }

        return None

    def check_task_read_auth(
        self, auth_header: str, task_id: str
    ) -> Optional[Tuple[int, Dict[str, Any]]]:
        """Auth ladder for GET /tasks/<id> (C1462/C1499), mirroring proto
        prototype/src/core/auth.ts decideReadAuth with ownership narrowing:
        admin or the owning agent's per-task token is accepted; a valid token
        belonging to a DIFFERENT agent is 403; anonymous/malformed headers,
        runner tokens (narrowed reads are not runner credentials), revoked and
        unknown tokens all get the shared 401 body. Auth resolves before
        existence: a valid agent credential on an unknown task still reaches
        the 404 (unknown tasks narrow nothing).

        Returns (http_status, error_payload) when the request must be
        rejected, else None.
        """
        with self.lock:
            unauthorized = (
                401,
                {"error": "unauthorized", "message": "Missing or invalid bearer token"},
            )
            match = re.match(r"^Bearer\s+(\S+)$", (auth_header or "").strip())
            presented = match.group(1) if match else None
            if presented is None:
                return unauthorized
            if self.expected_admin_token and presented == self.expected_admin_token:
                return None
            if self.expected_runner_token and presented == self.expected_runner_token:
                # RUNNER_TOKEN is accepted on unnarrowed reads (/status) only.
                return unauthorized
            if presented in self.revoked_tokens:
                # proto: credentialAgent denies revoked tokens on reads -> 401.
                return unauthorized
            owner = None
            for rec in self.tasks.values():
                if rec.get("token") == presented:
                    owner = rec
                    break
            if owner is None:
                return unauthorized
            target = self.tasks.get(task_id) or self.agents.get(task_id)
            if target is None or target.get("agent_id") == owner.get("agent_id"):
                return None
            return (
                403,
                {
                    "error": (
                        f"forbidden: this token belongs to {owner.get('agent_id')}, "
                        f"not {target.get('agent_id')}"
                    )
                },
            )

    def fork_owner(self, fork: Optional[str]) -> Optional[str]:
        """Resolve the owning agent of a fork name or URL (proto
        coordinator.forkOwner); None when the fork is unknown."""
        if not fork:
            return None
        with self.lock:
            for rec in self.tasks.values():
                if rec.get("forkUrl") == fork or (rec.get("fork") or {}).get("name") == fork:
                    return rec.get("agent_id")
        return None

    def check_mutating_auth(
        self, auth_header: str, required_agent: Optional[str]
    ) -> Optional[Tuple[int, Dict[str, Any]]]:
        """Auth ladder for POST /events/push (C1518), mirroring proto
        decideMutatingAuth with agent narrowing: ADMIN_TOKEN or the pushing
        agent's own task token is accepted; a valid token for a DIFFERENT
        agent is 403; anonymous/malformed headers, runner, revoked and
        unknown tokens get 401. The sidecar webhook bearer is not simulated
        by this mock.

        Returns (http_status, error_payload) when the request must be
        rejected, else None.
        """
        with self.lock:
            match = re.match(r"^Bearer\s+(\S+)$", (auth_header or "").strip())
            presented = match.group(1) if match else None
            if presented is None:
                return (
                    401,
                    {"error": "unauthorized: bearer token required"},
                )
            if self.expected_admin_token and presented == self.expected_admin_token:
                return None
            missing_credential = (
                401,
                {
                    "error": (
                        "unauthorized: ADMIN_TOKEN, the agent's task token "
                        "or the sidecar bearer required"
                    )
                },
            )
            if self.expected_runner_token and presented == self.expected_runner_token:
                # RUNNER_TOKEN is a /checks credential, not a push credential.
                return missing_credential
            if presented in self.revoked_tokens:
                # proto: credentialAgent denies revoked tokens -> falls to 401.
                return missing_credential
            owner = None
            for rec in self.tasks.values():
                if rec.get("token") == presented:
                    owner = rec
                    break
            if owner is None:
                return missing_credential
            if required_agent is None or owner.get("agent_id") == required_agent:
                return None
            return (
                403,
                {
                    "error": (
                        f"forbidden: this token belongs to {owner.get('agent_id')}, "
                        f"not {required_agent}"
                    )
                },
            )

    def create_task(self, data: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            self.seq += 1
            seq_str = f"{self.seq:04d}"
            agent_raw = data.get("agent") or "alpha"
            slug = re.sub(r"[^a-z0-9._-]+", "-", agent_raw.lower()).strip("-") or "alpha"
            agent_id = f"{slug}-{seq_str}"
            task_id = f"task-{seq_str}"
            repo = data.get("repo", "https://github.com/agent-branches/repo.git")
            base_sha = data.get("base_sha") or "0000000000000000000000000000000000000000"
            branch = data.get("branch") or "main"
            intent = data.get("intent", "")
            fork_url = f"https://git.cloudflare.local/forks/{agent_id}.git"
            ref = f"refs/heads/{branch}"
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()

            record = {
                "id": task_id,
                "taskId": task_id,
                "task_id": task_id,
                "agentId": agent_id,
                "agent_id": agent_id,
                "repo": repo,
                "base_sha": base_sha,
                "branch": branch,
                "ref": ref,
                "intent": intent,
                "forkUrl": fork_url,
                "fork_url": fork_url,
                "fork": {
                    "name": f"{self.canonical_name}-{agent_id}",
                    "remote": fork_url,
                },
                "token": f"mock-token-{seq_str}",
                "head": base_sha,
                "head_sha": base_sha,
                "pushes": 0,
                "status": "active",
                "files_changed": [],
                "test_provenance": None,
                "createdAt": now,
                "created_at": now,
                "last_push_at": None,
            }

            self.tasks[task_id] = record
            self.agents[agent_id] = record
            return record

    def record_push(self, data: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            agent_id = data.get("agentId") or data.get("agent")
            head_sha = data.get("head_sha") or data.get("sha")

            if not agent_id or not head_sha:
                raise ValueError("agentId (or agent) and head_sha (or sha) are required")

            # Enforce distinct agentId vs taskId: reject if client sends taskId directly
            if agent_id in self.tasks and agent_id not in self.agents:
                raise KeyError(
                    f"unknown agent: {agent_id} (received taskId instead of agentId)"
                )

            task = self.agents.get(agent_id)
            if not task:
                raise KeyError(f"unknown agent: {agent_id}")

            canonical_task_id = task["task_id"]
            dedup_key = (agent_id, head_sha)

            if dedup_key in self.seen_pushes or task.get("head_sha") == head_sha:
                return {
                    "accepted": True,
                    "deduped": True,
                    "agentId": agent_id,
                    "agent_id": agent_id,
                    "task_id": canonical_task_id,
                    "head_sha": head_sha,
                    "heads": {t["task_id"]: t["head_sha"] for t in self.tasks.values()},
                    "new_warnings": [],
                    "invalidated_warnings": [],
                    "radar_checks": 0,
                }

            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            self.seen_pushes.add(dedup_key)
            task["head"] = head_sha
            task["head_sha"] = head_sha
            task["pushes"] += 1
            task["last_push_at"] = now

            if "base_sha" in data and data["base_sha"]:
                task["base_sha"] = data["base_sha"]
            if "intent" in data and data["intent"]:
                task["intent"] = data["intent"]
            elif "intent_update" in data and data["intent_update"]:
                task["intent"] = data["intent_update"]
            if "test_provenance" in data and data["test_provenance"]:
                task["test_provenance"] = data["test_provenance"]

            raw_files = data.get("files_changed")
            files_changed: List[str] = []
            if isinstance(raw_files, list):
                files_changed = [str(f) for f in raw_files]
            elif isinstance(raw_files, str):
                files_changed = [f.strip() for f in raw_files.split(",") if f.strip()]
            if files_changed:
                task["files_changed"] = files_changed

            # Invalidate older active warnings for this task
            invalidated: List[str] = []
            for w in self.warnings.values():
                if w.get("status") == "active" and canonical_task_id in w.get("pair", []):
                    w["status"] = "invalidated"
                    w["invalidated_at"] = now
                    invalidated.append(w["warning_id"])

            # Simulate pairwise radar merge-tree check
            new_warnings: List[Dict[str, Any]] = []
            other_tasks = [t for t in self.tasks.values() if t["task_id"] != canonical_task_id]
            radar_checks = len(other_tasks)

            for other in other_tasks:
                other_id = other["task_id"]
                other_files = set(other.get("files_changed", []))
                cur_files = set(files_changed)
                overlap = list(cur_files & other_files)

                # Trigger conflict if common files are modified or explicit test marker
                has_conflict = bool(overlap) or "conflict" in str(task.get("intent", "")).lower()

                if has_conflict:
                    warn_idx = len(self.warnings) + 1
                    warn_id = f"warn-{warn_idx:03d}"
                    conflicting = overlap if overlap else ["src/auth.ts"]
                    kind = "test" if "fail" in str(task.get("test_provenance", "")).lower() else "textual"
                    warn_record = {
                        "warning_id": warn_id,
                        "id": warn_id,
                        "pair": [canonical_task_id, other_id],
                        "heads": {
                            canonical_task_id: head_sha,
                            other_id: other.get("head_sha", "unknown"),
                        },
                        "kind": kind,
                        "evidence": {
                            "conflicting_files": conflicting,
                            "conflict_type": "content_conflict",
                            "details": f"Trial merge detected conflict between {canonical_task_id} and {other_id}",
                        },
                        "status": "active",
                        "created_at_ms": int(time.time() * 1000),
                        "created_at": now,
                        "invalidated_at": None,
                    }
                    self.warnings[warn_id] = warn_record
                    new_warnings.append(warn_record)
                    self.radar_log.append({
                        "at": now,
                        "pair": [canonical_task_id, other_id],
                        "reason": f"conflict in {conflicting}",
                    })

            return {
                "accepted": True,
                "deduped": False,
                "agentId": agent_id,
                "agent_id": agent_id,
                "task_id": canonical_task_id,
                "head_sha": head_sha,
                "heads": {t["task_id"]: t["head_sha"] for t in self.tasks.values()},
                "new_warnings": new_warnings,
                "invalidated_warnings": invalidated,
                "radar_checks": radar_checks,
            }

    def get_status(self) -> Dict[str, Any]:
        with self.lock:
            active_warnings = [w for w in self.warnings.values() if w.get("status") == "active"]
            agents_list = []
            heads_dict = {}
            for t in self.tasks.values():
                t_id = t["task_id"]
                a_id = t.get("agent_id") or t_id
                sha = t.get("head_sha")
                if sha:
                    heads_dict[a_id] = sha
                    heads_dict[t_id] = sha
                agents_list.append({
                    "agentId": a_id,
                    "taskId": t_id,
                    "intent": t.get("intent"),
                    "baseSha": t.get("base_sha"),
                    "head": sha,
                })
            return {
                "canonical": {
                    "name": self.canonical_name,
                    "remote": self.canonical_remote,
                },
                "tasks": list(self.tasks.values()),
                "agents": agents_list,
                "heads": heads_dict,
                "warnings": active_warnings,
                "radar_log": self.radar_log[-20:],
                "unprocessedPushes": [],
            }

    def get_task(self, task_id: str) -> Dict[str, Any]:
        with self.lock:
            task = self.tasks.get(task_id) or self.agents.get(task_id)
            if not task:
                raise KeyError(f"unknown task: {task_id}")
            res = dict(task)
            canonical_id = task["task_id"]
            res["warnings"] = [
                w for w in self.warnings.values()
                if canonical_id in w.get("pair", []) and w.get("status") == "active"
            ]
            return res

    def ack_warning(self, warning_id: str, task_id: Optional[str], action: str) -> Dict[str, Any]:
        with self.lock:
            warning = self.warnings.get(warning_id)
            if not warning:
                raise KeyError(f"unknown warning: {warning_id}")

            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            warning["status"] = "acknowledged"
            warning["acknowledged"] = True
            warning["acknowledged_at"] = now
            warning["action"] = action
            warning["ack_task_id"] = task_id

            return {
                "acknowledged": True,
                "warning_id": warning_id,
                "task_id": task_id,
                "action": action,
                "status": "acknowledged",
                "acknowledged_at": now,
            }

    def apply_checks(self, data: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            contract = data.get("contract")
            if contract != "0.1":
                raise ValueError("contract must be '0.1'")

            vector = data.get("vector")
            if not isinstance(vector, dict):
                raise ValueError("vector must be a dictionary")

            results = data.get("results")
            if not isinstance(results, list):
                raise ValueError("results must be a list")

            # Check vector freshness against current heads in state
            current_heads: Dict[str, str] = {}
            for t in self.tasks.values():
                if t.get("head_sha"):
                    current_heads[t["agent_id"]] = t["head_sha"]
                    current_heads[t["task_id"]] = t["head_sha"]

            for agent_or_task, expected_sha in vector.items():
                actual_sha = current_heads.get(agent_or_task)
                if actual_sha is not None and actual_sha != expected_sha:
                    raise MockStaleVectorError(
                        f"Head vector is stale: {agent_or_task} is at {actual_sha}, "
                        f"vector specified {expected_sha}"
                    )

            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            created_warnings: List[Dict[str, Any]] = []
            pair_views: List[Dict[str, Any]] = []

            for r in results:
                pair = r.get("pair", [])
                status = r.get("status", "unknown")
                kind = r.get("kind")
                evidence = r.get("evidence")

                active_warning_ids = []
                if status == "conflict":
                    warn_idx = len(self.warnings) + 1
                    warn_id = f"warn-chk-{warn_idx:03d}"
                    reason = (
                        evidence.get("summary")
                        if isinstance(evidence, dict) and evidence.get("summary")
                        else str(evidence or "conflict")
                    )
                    warn_record = {
                        "warning_id": warn_id,
                        "id": warn_id,
                        "pair": pair,
                        "kind": kind or "textual",
                        "reason": reason,
                        "evidence": evidence,
                        "status": "active",
                        "created_at_ms": int(time.time() * 1000),
                        "created_at": now,
                    }
                    self.warnings[warn_id] = warn_record
                    created_warnings.append(warn_record)
                    active_warning_ids.append(warn_id)
                elif status == "clean":
                    # Invalidate active warnings for this pair
                    for w in self.warnings.values():
                        if w.get("status") == "active" and all(
                            p in w.get("pair", []) for p in pair
                        ):
                            w["status"] = "invalidated"
                            w["invalidated_at"] = now
                            w["resolved_by"] = "clean check"

                pair_views.append({
                    "pair": pair,
                    "heads": r.get("heads", {}),
                    "status": status,
                    "kind": kind,
                    "evidence": evidence,
                    "checkedAt": now,
                    "stale": False,
                    "activeWarningIds": active_warning_ids,
                })

            return {
                "accepted": len(results),
                "pairs": pair_views,
                "createdWarnings": created_warnings,
            }



class MockL1Handler(http.server.BaseHTTPRequestHandler):
    """HTTP Request Handler implementing L1 Coordinator routes."""

    # Silence default console logging
    def log_message(self, format: str, *args: Any) -> None:
        pass

    @property
    def state(self) -> MockCoordinatorState:
        return self.server.state  # type: ignore

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> Dict[str, Any]:
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length <= 0:
            return {}
        raw = self.rfile.read(content_length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            raise ValueError("request body must be valid JSON")

    def do_POST(self) -> None:
        path = urllib.parse.urlparse(self.path).path

        # POST /tasks
        if path == "/tasks":
            # Admin token auth check if configured (revocation, validity, expiry)
            if self.state.expected_admin_token is not None:
                err = self.state.check_bearer_token(
                    self.headers.get("Authorization", ""),
                    self.state.expected_admin_token,
                    self.state.admin_token_expires_at,
                    "admin",
                )
                if err:
                    self._send_json(err[0], err[1])
                    return

            try:
                body = self._read_json()
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
                return
            created = self.state.create_task(body)
            if self.state.token_wire_object and isinstance(created.get("token"), str):
                # C1509/C1515: real coordinator CreateTaskResult wire shape
                # (prototype/src/core/coordinator.ts) — the minted token is
                # an object and ref stays TOP LEVEL (fork is {name, remote});
                # the stored record keeps the plaintext string for bearer
                # comparisons.
                created = dict(created)
                created["token"] = {
                    "scope": f"task:{created.get('taskId')}",
                    "expiresAt": int(time.time()) + 3600,
                    "plaintext": created["token"],
                }
            self._send_json(201, created)
            return

        # POST /events/push
        if path == "/events/push":
            try:
                body = self._read_json()
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
                return
            self.state.last_authorization = self.headers.get("Authorization")
            # C1518: pushes are privileged (muse-r46 AUTH / proto
            # decideMutatingAuth) when the mock runs with a configured admin
            # token — admin or the pushing agent's own task token; the
            # unconfigured default stays open for legacy fixtures. Like the
            # proto router, the required agent resolves from the body (agent
            # or fork owner) before auth.
            if self.state.expected_admin_token is not None:
                required_agent = body.get("agentId") or body.get("agent")
                if not required_agent:
                    required_agent = self.state.fork_owner(body.get("fork"))
                err = self.state.check_mutating_auth(
                    self.headers.get("Authorization", ""), required_agent
                )
                if err:
                    self._send_json(err[0], err[1])
                    return
            try:
                res = self.state.record_push(body)
                self._send_json(200, res)
            except KeyError as exc:
                self._send_json(404, {"error": str(exc).strip("'")})
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
            return

        # POST /checks (CONTRACT v0.1)
        if path == "/checks":
            if self.state.expected_runner_token is not None:
                err = self.state.check_bearer_token(
                    self.headers.get("Authorization", ""),
                    self.state.expected_runner_token,
                    self.state.runner_token_expires_at,
                    "runner",
                )
                if err:
                    self._send_json(err[0], err[1])
                    return

            try:
                body = self._read_json()
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
                return

            try:
                res = self.state.apply_checks(body)
                self._send_json(200, res)
            except MockStaleVectorError as exc:
                self._send_json(409, {
                    "error": "stale_vector",
                    "message": str(exc),
                })
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
            return

        # POST /warnings/<id>/ack
        ack_match = re.match(r"^/warnings/([^/]+)/ack$", path)
        if ack_match:
            warning_id = urllib.parse.unquote(ack_match.group(1))
            try:
                body = self._read_json()
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
                return
            task_id = body.get("task_id")
            action = body.get("action", "acknowledged")
            try:
                res = self.state.ack_warning(warning_id=warning_id, task_id=task_id, action=action)
                self._send_json(200, res)
            except KeyError as exc:
                self._send_json(404, {"error": str(exc).strip("'")})
            return

        self._send_json(404, {"error": f"no route for POST {path}"})

    def do_GET(self) -> None:
        path = urllib.parse.urlparse(self.path).path

        # GET /status
        if path == "/status":
            self._send_json(200, self.state.get_status())
            return

        # GET /tasks/<id>
        task_match = re.match(r"^/tasks/([^/]+)$", path)
        if task_match:
            task_id = urllib.parse.unquote(task_match.group(1))
            self.state.last_authorization = self.headers.get("Authorization")
            # C1462/C1499: owner-or-admin read auth when the mock runs with a
            # configured admin token (same conditional pattern as POST /tasks);
            # the unconfigured default stays an open read for legacy fixtures.
            if self.state.expected_admin_token is not None:
                err = self.state.check_task_read_auth(
                    self.headers.get("Authorization", ""), task_id
                )
                if err:
                    self._send_json(err[0], err[1])
                    return
            try:
                res = self.state.get_task(task_id)
                self._send_json(200, res)
            except KeyError as exc:
                self._send_json(404, {"error": str(exc).strip("'")})
            return

        self._send_json(404, {"error": f"no route for GET {path}"})


class MockL1Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """Threaded HTTP server holding coordinator state."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address: Tuple[str, int], state: Optional[MockCoordinatorState] = None):
        super().__init__(server_address, MockL1Handler)
        self.state = state or MockCoordinatorState()


def start_mock_l1_server(
    host: str = "127.0.0.1",
    port: int = 0,
    expected_admin_token: Optional[str] = None,
    expected_runner_token: Optional[str] = None,
    admin_token_expires_at: Optional[float] = None,
    runner_token_expires_at: Optional[float] = None,
    token_wire_object: bool = True,
) -> Tuple[MockL1Server, threading.Thread, str, MockCoordinatorState]:
    """Start mock L1 coordinator on host and ephemeral or specified port.

    Token expiry timestamps are epoch seconds: a correct token presented at or
    after its expiry is rejected with 401 {"error": "token_expired"}. Tokens can
    be revoked at runtime via ``state.revoke_token(token)`` which makes later
    requests fail with 403 {"error": "token_revoked"}.

    Returns:
        (server, thread, server_url, state)
    """
    state = MockCoordinatorState(
        expected_admin_token=expected_admin_token,
        expected_runner_token=expected_runner_token,
        admin_token_expires_at=admin_token_expires_at,
        runner_token_expires_at=runner_token_expires_at,
        token_wire_object=token_wire_object,
    )
    server = MockL1Server((host, port), state=state)
    actual_port = server.server_address[1]
    server_url = f"http://{host}:{actual_port}"

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, server_url, state



def main() -> None:
    parser = argparse.ArgumentParser(description="Run Mock L1 Coordinator Server")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8787, help="Bind port (default: 8787)")
    parser.add_argument("--admin-token", help="Require admin bearer token for task creation")
    args = parser.parse_args()

    server, thread, url, _ = start_mock_l1_server(
        host=args.host, port=args.port, expected_admin_token=args.admin_token
    )
    print(f"Mock L1 Coordinator Server listening at {url}")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nShutting down server...")
        server.shutdown()
        server.server_close()
        sys.exit(0)


if __name__ == "__main__":
    main()
