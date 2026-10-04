"""Agent Branches L2 Client implementation using standard library urllib."""

import copy
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Union


class AgentBranchesError(Exception):
    """Base exception for all agent-branches client errors."""
    pass


class AgentBranchesConnectionError(AgentBranchesError):
    """Raised when the client cannot connect to the L1 coordinator server."""
    pass


class AgentBranchesAPIError(AgentBranchesError):
    """Raised when the L1 coordinator returns an HTTP error response."""

    def __init__(self, status_code: int, message: str, payload: Optional[Any] = None):
        super().__init__(f"HTTP {status_code}: {message}")
        self.status_code = status_code
        self.message = message
        self.payload = payload


class StaleVectorError(AgentBranchesAPIError):
    """Raised when the L1 coordinator returns HTTP 409 Conflict due to a stale head vector.

    ``fresh_vector`` carries the coordinator's current head vector (agentId and
    taskId keys) when the client was able to resync it, so the caller can
    explicitly re-evaluate checks against current state.
    """

    def __init__(self, status_code: int, message: str, payload: Optional[Any] = None):
        super().__init__(status_code, message, payload)
        self.fresh_vector: Optional[Dict[str, str]] = None


class TokenExpiredError(AgentBranchesAPIError):
    """Raised when the coordinator rejects a request because the bearer token has expired.

    Fail-closed: the caller must obtain fresh credentials; the client never
    auto-retries an expired-token request.
    """
    pass


class TokenRevokedError(AgentBranchesAPIError):
    """Raised when the coordinator rejects a request because the bearer token was revoked.

    Fail-closed: retrying can never succeed; the client must halt and
    surface the revoked credentials to the operator.
    """
    pass


class BatchExecutionError(AgentBranchesAPIError):
    """Raised when one or more events in a push_batch fail.

    Carries structured receipts so callers can inspect partial successes,
    the exact failure index, the underlying cause, and unattempted events.
    """

    def __init__(
        self,
        message: str,
        succeeded: List[Dict[str, Any]],
        failed_index: int,
        original_error: Exception,
        unattempted_events: List[Dict[str, Any]],
    ):
        status_code = getattr(original_error, "status_code", 0)
        payload = getattr(original_error, "payload", None)
        super().__init__(status_code, message, payload)
        self.succeeded: List[Dict[str, Any]] = succeeded
        self.completed: List[Dict[str, Any]] = succeeded
        self.failed_index: int = failed_index
        self.original_error: Exception = original_error
        self.unattempted_events: List[Dict[str, Any]] = unattempted_events

    def __str__(self) -> str:
        return (
            f"BatchExecutionError(failed_at_index={self.failed_index}, "
            f"succeeded={len(self.succeeded)}, unattempted={len(self.unattempted_events)}, "
            f"cause={self.original_error})"
        )


class AgentBranchesClient:
    """Robust, lightweight client for Cloudflare Agent Branches L1 Coordinator."""

    DEFAULT_SERVER = "http://127.0.0.1:8787"

    def __init__(self, server_url: Optional[str] = None, timeout: float = 10.0):
        url = (
            server_url
            or os.environ.get("AGENT_BRANCHES_SERVER")
            or os.environ.get("COORDINATOR_URL")
            or self.DEFAULT_SERVER
        )
        self.server_url = url.rstrip("/")
        self.timeout = timeout
        self.task_to_agent: Dict[str, str] = {}
        self.known_tasks: Dict[str, Dict[str, Any]] = {}
        # taskId -> per-task bearer token minted at create_task (C1499); used
        # to authenticate owner-scoped reads such as GET /tasks/:id.
        self.task_tokens: Dict[str, str] = {}

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Perform an HTTP request and parse JSON response."""
        full_url = f"{self.server_url}{path}"
        data = None
        req_headers = {
            "Accept": "application/json",
            "User-Agent": "agent-branches-l2-client/1.0",
        }
        if headers:
            req_headers.update(headers)

        if body is not None:
            data = json.dumps(body).encode("utf-8")
            req_headers["Content-Type"] = "application/json; charset=utf-8"

        req = urllib.request.Request(full_url, data=data, headers=req_headers, method=method)

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                resp_bytes = response.read()
                if not resp_bytes:
                    return {}
                return json.loads(resp_bytes.decode("utf-8"))
        except urllib.error.HTTPError as exc:
            err_body = exc.read()
            err_msg = exc.reason
            payload = None
            if err_body:
                try:
                    payload = json.loads(err_body.decode("utf-8"))
                    if isinstance(payload, dict):
                        err_msg = payload.get("message") or payload.get("error") or err_msg
                except Exception:
                    err_msg = err_body.decode("utf-8", errors="replace")
            if exc.code == 409:
                raise StaleVectorError(exc.code, str(err_msg), payload) from exc
            if exc.code in (401, 403):
                err_code = ""
                if isinstance(payload, dict):
                    err_code = str(payload.get("error") or "")
                auth_blob = f"{err_code} {err_msg}".lower()
                if "expired" in auth_blob:
                    raise TokenExpiredError(exc.code, str(err_msg), payload) from exc
                if "revoked" in auth_blob:
                    raise TokenRevokedError(exc.code, str(err_msg), payload) from exc
            raise AgentBranchesAPIError(exc.code, str(err_msg), payload) from exc

        except (urllib.error.URLError, ConnectionError, OSError) as exc:
            reason = getattr(exc, "reason", str(exc))
            raise AgentBranchesConnectionError(
                f"Failed to connect to coordinator at {self.server_url}: {reason}"
            ) from exc

    def create_task(
        self,
        repo: str,
        base_sha: str,
        intent: str,
        branch: str,
        agent: Optional[str] = None,
        ttl_seconds: Optional[int] = None,
        admin_token: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Register a new task (POST /tasks).

        Supports --admin-token (or $ADMIN_TOKEN) via Authorization: Bearer <token>.
        Returns dictionary containing distinct task ID, agent ID, fork URL, branch, token, etc.
        """
        payload: Dict[str, Any] = {
            "repo": repo,
            "base_sha": base_sha,
            "intent": intent,
            "branch": branch,
        }
        if agent:
            payload["agent"] = agent
        if ttl_seconds is not None:
            payload["ttlSeconds"] = ttl_seconds

        req_headers: Dict[str, str] = {}
        token = admin_token or os.environ.get("ADMIN_TOKEN")
        if token:
            req_headers["Authorization"] = f"Bearer {token}"

        res = self._request("POST", "/tasks", payload, headers=req_headers)

        task_id = res.get("taskId") or res.get("id") or res.get("task_id")
        agent_id = res.get("agentId") or res.get("agent_id") or res.get("agent")

        # Normalize keys in returned dict
        if task_id:
            res["taskId"] = task_id
            res["task_id"] = task_id
        if agent_id:
            res["agentId"] = agent_id
            res["agent_id"] = agent_id

        if task_id and agent_id:
            self.task_to_agent[task_id] = agent_id
            self.known_tasks[task_id] = res

        # Cache the minted per-task bearer token so later reads of this task
        # (get_task, push agent resolution) authenticate as the owning agent.
        # Real coordinators mint the token as an object {scope, expiresAt,
        # plaintext} (CreateTaskResult, C1509); older deployments and legacy
        # mocks return the plaintext string directly. Only the plaintext
        # string may ever reach the Authorization header.
        raw_token = res.get("token")
        if isinstance(raw_token, dict):
            plaintext = raw_token.get("plaintext", "")
            if task_id and plaintext:
                self.task_tokens[task_id] = plaintext
        elif isinstance(raw_token, str) and task_id and raw_token:
            self.task_tokens[task_id] = raw_token

        # Flatten the fork wire object into plain keys for CLI consumers.
        # C1515: on the real CreateTaskResult (prototype/src/core/coordinator.ts)
        # ref is TOP LEVEL and fork is {name, remote} only — a nested fork.ref
        # was a mock artifact. fork_ref resolves nested (legacy) first, then
        # top-level ref, then the branch; fork_remote from the fork object or
        # legacy flat keys.
        raw_fork = res.get("fork")
        nested_ref = raw_fork.get("ref") if isinstance(raw_fork, dict) and raw_fork.get("ref") else None
        res["fork_ref"] = nested_ref or res.get("ref") or res.get("branch")
        res["fork_remote"] = (
            (raw_fork.get("remote") if isinstance(raw_fork, dict) else None)
            or res.get("forkRemote")
            or res.get("remote")
        )

        return res

    def get_task(self, task_id: str, token: Optional[str] = None) -> Dict[str, Any]:
        """Fetch task status and active warnings for a specific task (GET /tasks/:id).

        GET /tasks/:id is owner-or-admin on authenticated coordinators (C1499),
        so the request carries a bearer token resolved in this order: the
        explicit ``token`` argument, the per-task token cached by
        ``create_task``, $TASK_TOKEN, then $ADMIN_TOKEN. Anonymous requests
        are rejected with 401.

        Returns the full task record including distinct agentId and taskId.
        """
        encoded_id = urllib.parse.quote(task_id, safe="")
        effective_token = (
            token
            or self.task_tokens.get(task_id)
            or os.environ.get("TASK_TOKEN")
            or os.environ.get("ADMIN_TOKEN")
        )
        req_headers: Optional[Dict[str, str]] = None
        if effective_token:
            req_headers = {"Authorization": f"Bearer {effective_token}"}
        res = self._request("GET", f"/tasks/{encoded_id}", headers=req_headers)

        t_id = res.get("taskId") or res.get("id") or res.get("task_id") or task_id
        a_id = res.get("agentId") or res.get("agent_id") or res.get("agent")
        if t_id:
            res["taskId"] = t_id
            res["task_id"] = t_id
        if a_id:
            res["agentId"] = a_id
            res["agent_id"] = a_id
            self.task_to_agent[t_id] = a_id

        self.known_tasks[t_id] = res
        return res

    def push(
        self,
        task_id: Optional[str] = None,
        head_sha: str = "",
        base_sha: Optional[str] = None,
        files_changed: Optional[Union[List[str], str]] = None,
        intent: Optional[str] = None,
        test_provenance: Optional[str] = None,
        agent_id: Optional[str] = None,
        token: Optional[str] = None,
        admin_token: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Register a WIP commit push (POST /events/push).

        Sends agentId (required by L1 coordinator), head_sha, base_sha, files_changed, intent, test_provenance.
        If agent_id is not passed, resolves it via task_id mapping or an
        authenticated get_task(task_id) lookup (C1499: the per-task token
        cached by create_task authenticates the read as the owning agent;
        C1532: an explicit ``token``/``admin_token`` is applied to that
        lookup first, so cold clients resolve agentId without a 401).

        C1518: POST /events/push is a privileged mutation (muse-r46 AUTH):
        the real coordinator answers 401 unless the bearer is the pushing
        agent's own task token or ADMIN_TOKEN. The token is resolved as:
        explicit ``token`` -> the per-task token cached by ``create_task``
        -> explicit ``admin_token`` -> $ADMIN_TOKEN. With none available
        the request goes out unauthenticated and fails closed with 401.
        """
        # C1532: resolve the mutating bearer BEFORE the agent_id lookup — a
        # cold client (no cached token) holding only an explicit token= or
        # admin_token= must authenticate its get_task() resolution too, and
        # the same bearer is attached to the POST below (C1518).
        effective_token = (
            token
            or (self.task_tokens.get(task_id) if task_id else None)
            or admin_token
            or os.environ.get("ADMIN_TOKEN")
        )

        # Resolve agent_id if not explicitly provided
        effective_agent_id = agent_id
        if not effective_agent_id and task_id:
            if task_id in self.task_to_agent:
                effective_agent_id = self.task_to_agent[task_id]
            else:
                try:
                    task_rec = self.get_task(task_id, token=effective_token)
                    effective_agent_id = (
                        task_rec.get("agentId")
                        or task_rec.get("agent_id")
                        or task_rec.get("agent")
                    )
                except Exception as exc:
                    raise ValueError(
                        f"Cannot resolve agentId for task '{task_id}'. "
                        f"Task lookup failed: {exc}. "
                        "Specify agent_id explicitly."
                    ) from exc

        if not effective_agent_id:
            raise ValueError(
                f"Cannot resolve agentId for task '{task_id}'. "
                "Task lookup failed or task record is missing agentId. "
                "Specify agent_id explicitly."
            )

        # Normalize files_changed to list of non-empty strings
        normalized_files: Optional[List[str]] = None
        if files_changed is not None:
            if isinstance(files_changed, str):
                normalized_files = [f.strip() for f in files_changed.split(",") if f.strip()]
            else:
                normalized_files = list(files_changed)

        # L1 coordinator requires agent / agentId
        payload: Dict[str, Any] = {
            "agentId": effective_agent_id,
            "agent": effective_agent_id,
            "head_sha": head_sha,
            "sha": head_sha,
        }
        if task_id:
            payload["task_id"] = task_id
            payload["taskId"] = task_id
        if base_sha:
            payload["base_sha"] = base_sha
        if normalized_files is not None:
            payload["files_changed"] = normalized_files
        if intent:
            payload["intent"] = intent
            payload["intent_update"] = intent
        if test_provenance:
            payload["test_provenance"] = test_provenance

        # C1518: attach the mutating bearer (pushing agent's task token or
        # admin); a bare POST would be rejected by requireMutatingAuth.
        req_headers: Dict[str, str] = {}
        if effective_token:
            req_headers["Authorization"] = f"Bearer {effective_token}"

        return self._request("POST", "/events/push", payload, headers=req_headers)

    def push_batch(
        self,
        events: List[Dict[str, Any]],
        token: Optional[str] = None,
        admin_token: Optional[str] = None,
        max_retries: int = 3,
        retry_backoff: float = 0.05,
    ) -> List[Dict[str, Any]]:
        """Register a batch of WIP commit pushes with upfront pre-validation and transient retries.

        Phase 1: Upfront validation & pre-resolution
        - Validates all events upfront (type, non-empty, 40-char hex SHA, task_id/agent_id).
        - Pre-resolves agent_id for all events BEFORE any mutating push is dispatched.
          If any event fails validation or pre-resolution, raises ValueError/TypeError
          fail-closed, guaranteeing zero partial coordinator mutation for invalid inputs.

        Phase 2: Forward-only sequential execution with bounded exponential retry
        - Dispatches each push sequentially with the pre-resolved agent_id.
        - Classifies transient errors (connection failures, HTTP 429, HTTP >= 500)
          and retries up to max_retries with exponential backoff.
        - Non-transient errors (400, 401, 403, 404, 409) fail immediately without retrying.
        - On failure or exhausted retries, raises BatchExecutionError containing
          structured receipts (succeeded, failed_index, original_error, unattempted_events),
          preserving partial results and preventing replay hazards.
        """
        # Phase 1: Input pre-validation
        if not isinstance(events, list):
            raise TypeError("events must be a list of event dictionaries")
        if len(events) == 0:
            raise ValueError("events list cannot be empty")
        if not isinstance(max_retries, int) or max_retries < 0:
            raise ValueError("max_retries must be an integer >= 0")
        if not isinstance(retry_backoff, (int, float)) or retry_backoff < 0:
            raise ValueError("retry_backoff must be a number >= 0")

        resolved_agents: List[str] = []
        for idx, ev in enumerate(events):
            if not isinstance(ev, dict):
                raise TypeError(f"event at index {idx} must be a dictionary")
            sha = ev.get("head_sha") or ev.get("sha")
            if not sha or not isinstance(sha, str):
                raise ValueError(f"event at index {idx} missing required head_sha")
            if len(sha) != 40 or not all(c in "0123456789abcdefABCDEF" for c in sha):
                raise ValueError(
                    f"event at index {idx} has invalid head_sha (must be 40-character hex SHA): {sha}"
                )
            task_id = ev.get("task_id") or ev.get("taskId")
            agent_id = ev.get("agent_id") or ev.get("agentId")
            if not task_id and not agent_id:
                raise ValueError(f"event at index {idx} missing required task_id or agent_id")

            # Pre-resolve agent_id
            resolved_agent = None
            if agent_id:
                resolved_agent = str(agent_id)
            elif task_id in self.task_to_agent:
                resolved_agent = self.task_to_agent[task_id]
            else:
                lookup_token = (
                    ev.get("token")
                    or token
                    or self.task_tokens.get(task_id)
                    or ev.get("admin_token")
                    or admin_token
                    or os.environ.get("ADMIN_TOKEN")
                )
                try:
                    task_rec = self.get_task(task_id, token=lookup_token)
                    resolved_agent = (
                        task_rec.get("agentId")
                        or task_rec.get("agent_id")
                        or task_rec.get("agent")
                    )
                except Exception as exc:
                    raise ValueError(
                        f"Cannot resolve agentId for task '{task_id}' at index {idx}: {exc}"
                    ) from exc

            if not resolved_agent:
                raise ValueError(
                    f"Cannot resolve agentId for task '{task_id}' at index {idx}. "
                    "Task lookup failed or task record is missing agentId. "
                    "Specify agent_id explicitly."
                )
            resolved_agents.append(resolved_agent)

        # Phase 2: Forward-only execution with transient retries
        results: List[Dict[str, Any]] = []
        for idx, ev in enumerate(events):
            attempt = 0
            resolved_agent = resolved_agents[idx]
            task_id = ev.get("task_id") or ev.get("taskId")
            sha = ev.get("head_sha") or ev.get("sha") or ""
            base_sha = ev.get("base_sha")
            files_changed = ev.get("files_changed")
            intent = ev.get("intent") or ev.get("intent_update")
            test_provenance = ev.get("test_provenance")
            ev_token = ev.get("token") or token
            ev_admin_token = ev.get("admin_token") or admin_token

            while True:
                try:
                    res = self.push(
                        task_id=task_id,
                        head_sha=sha,
                        base_sha=base_sha,
                        files_changed=files_changed,
                        intent=intent,
                        test_provenance=test_provenance,
                        agent_id=resolved_agent,
                        token=ev_token,
                        admin_token=ev_admin_token,
                    )
                    results.append(res)
                    break
                except Exception as err:
                    is_transient = isinstance(err, AgentBranchesConnectionError) or (
                        isinstance(err, AgentBranchesAPIError)
                        and (err.status_code >= 500 or err.status_code == 429)
                    )
                    if is_transient and attempt < max_retries:
                        attempt += 1
                        time.sleep(retry_backoff * (2 ** (attempt - 1)))
                        continue
                    unattempted = list(events[idx + 1:])
                    raise BatchExecutionError(
                        f"Batch execution failed at event index {idx}: {err}",
                        succeeded=list(results),
                        failed_index=idx,
                        original_error=err,
                        unattempted_events=unattempted,
                    ) from err

        return results

    def get_status(self, runner_token: Optional[str] = None) -> Dict[str, Any]:
        """Fetch current global coordinator and radar status (GET /status).

        GET /status is bearer-protected on current L1 deployments: pass
        ``runner_token`` (defaults to $RUNNER_TOKEN) for authenticated reads.
        """
        req_headers: Dict[str, str] = {}
        token = runner_token or os.environ.get("RUNNER_TOKEN")
        if token:
            req_headers["Authorization"] = f"Bearer {token}"
        return self._request("GET", "/status", headers=req_headers or None)

    def ack_warning(
        self,
        warning_id: str,
        task_id: Optional[str] = None,
        action: str = "acknowledged",
    ) -> Dict[str, Any]:
        """Acknowledge a radar warning (POST /warnings/:id/ack)."""
        encoded_id = urllib.parse.quote(warning_id, safe="")
        payload: Dict[str, Any] = {"action": action}
        if task_id:
            payload["task_id"] = task_id
            payload["taskId"] = task_id

        return self._request("POST", f"/warnings/{encoded_id}/ack", payload)

    def send_checks(
        self,
        payload: Dict[str, Any],
        runner_token: Optional[str] = None,
        return_error_dict: bool = False,
    ) -> Dict[str, Any]:
        """Submit radar evaluation check results to L1 coordinator (POST /checks).

        Validates CONTRACT v0.1 schema:
            payload must contain 'contract', 'vector', 'results'.

        Args:
            payload: CONTRACT v0.1 check payload dictionary.
            runner_token: Optional runner bearer token (defaults to $RUNNER_TOKEN).
            return_error_dict: If True, returns structured dict on 409 StaleVectorError
                               instead of raising exception.

        Returns:
            Coordinator response dict (e.g. {accepted, pairs, createdWarnings}).

        Raises:
            ValueError: If payload fails validation.
            StaleVectorError: On HTTP 409 Conflict (stale vector) if return_error_dict is False.
            AgentBranchesAPIError: On other API errors.
        """
        if not isinstance(payload, dict):
            raise ValueError("checks payload must be a JSON dictionary")
        if "contract" not in payload:
            raise ValueError("checks payload missing required 'contract' field")
        if "vector" not in payload:
            raise ValueError("checks payload missing required 'vector' field")
        if "results" not in payload or not isinstance(payload["results"], list):
            raise ValueError("checks payload missing required 'results' list")

        req_headers: Dict[str, str] = {}
        token = runner_token or os.environ.get("RUNNER_TOKEN")
        if token:
            req_headers["Authorization"] = f"Bearer {token}"

        try:
            return self._request("POST", "/checks", payload, headers=req_headers)
        except StaleVectorError as exc:
            if return_error_dict:
                return {
                    "error": "stale_vector",
                    "status_code": 409,
                    "message": exc.message,
                    "details": exc.payload,
                }
            raise

    def refresh_head_vector(self, runner_token: Optional[str] = None) -> Dict[str, str]:
        """Fetch the coordinator's current head vector (CONTRACT v0.1 resync source).

        Returns a mapping containing both ``agentId -> head_sha`` and
        ``taskId -> head_sha`` entries for every task/agent known to the coordinator,
        suitable for re-evaluating a stale ``vector`` after HTTP 409.

        Compatible with the real coordinator wire format (which returns ``heads: Record<string, string>``
        and ``agents: AgentRecord[]``) as well as mock servers returning ``tasks: TaskRecord[]``.
        """
        status = self.get_status(runner_token=runner_token)
        heads: Dict[str, str] = {}

        # 1. Real coordinator wire format: top-level 'heads' mapping {agentId: sha}
        raw_heads = status.get("heads")
        if isinstance(raw_heads, dict):
            for k, v in raw_heads.items():
                if k and v:
                    heads[str(k)] = str(v)

        # 2. Map task IDs <-> agent IDs from 'agents' list in real StatusResult
        for agent_rec in status.get("agents") or []:
            if not isinstance(agent_rec, dict):
                continue
            a_id = agent_rec.get("agentId") or agent_rec.get("agent_id") or agent_rec.get("id")
            t_id = agent_rec.get("taskId") or agent_rec.get("task_id")
            sha = agent_rec.get("head_sha") or agent_rec.get("head")
            if a_id and a_id in heads and t_id:
                heads[str(t_id)] = heads[a_id]
            elif t_id and t_id in heads and a_id:
                heads[str(a_id)] = heads[t_id]
            elif sha:
                if a_id:
                    heads[str(a_id)] = str(sha)
                if t_id:
                    heads[str(t_id)] = str(sha)

        # 3. Fallback for mock/test servers returning top-level 'tasks'
        for rec in status.get("tasks") or []:
            if not isinstance(rec, dict):
                continue
            sha = rec.get("head_sha") or rec.get("head")
            if not sha:
                continue
            for key in (
                rec.get("agentId") or rec.get("agent_id"),
                rec.get("taskId") or rec.get("task_id") or rec.get("id"),
            ):
                if key:
                    heads[str(key)] = str(sha)

        return heads

    @staticmethod
    def _validated_recomputed_payload(
        original_vector: Dict[str, Any],
        fresh_heads: Dict[str, str],
        recomputed: Any,
    ) -> Optional[Dict[str, Any]]:
        """Validate a recompute_fn result; return it, or None to fail closed.

        Guards against relabeling stale evidence as fresh: every original
        participant must still be present, pinned to the FRESH head sha (a
        recomputed payload still carrying stale shas is rejected), results must
        be a list, and every result pair must reference known participants.

        Note (C1494): The client enforces structural schema and participant head
        freshness. Semantic validity of trial merges and conflict evaluations
        remains guarded by the server-side coordinator 409 gate.
        """
        if not isinstance(recomputed, dict):
            return None
        if "contract" not in recomputed:
            return None
        results = recomputed.get("results")
        if not isinstance(results, list):
            return None
        vector = recomputed.get("vector")
        if not isinstance(vector, dict) or not vector:
            return None
        for key in original_vector:
            if key not in vector:
                return None  # missing participant: fail closed, never drop silently
            if str(vector[key]) != fresh_heads.get(key):
                return None  # stale head sha in "fresh" payload: reject
        for res in results:
            if not isinstance(res, dict):
                return None
            pair = res.get("pair")
            if not isinstance(pair, list):
                return None
            if any(participant not in vector for participant in pair):
                return None
        return recomputed

    def send_checks_with_resync(
        self,
        payload: Dict[str, Any],
        runner_token: Optional[str] = None,
        max_attempts: int = 2,
        recompute_fn: Optional[Any] = None,
    ) -> Dict[str, Any]:
        """Submit checks; on HTTP 409 stale vector, fail closed or recompute, never replay.

        The 409 stale gate exists to force re-evaluation against current heads.
        This method therefore NEVER re-sends the original ``results`` with an
        updated vector — that would relabel old evidence as fresh.

        On ``StaleVectorError`` the client fetches the coordinator's current
        head vector (authenticated status read) and attaches it to the raised
        exception as ``exc.fresh_vector``. Retry behavior depends on
        ``recompute_fn``:

        - ``recompute_fn is None`` (default): fail closed immediately — raise
          the ``StaleVectorError`` carrying ``fresh_vector`` so the caller can
          explicitly re-evaluate.
        - ``recompute_fn(current_heads) -> payload``: called with the fresh
          head vector; must return a complete CONTRACT v0.1 payload re-evaluated
          at those heads (every original participant present, pinned to the
          fresh shas, results consistent with the vector). A valid recomputed
          payload replaces the attempt payload and the submission is retried
          within the bounded budget. If ``recompute_fn`` is missing from a
          participant, returns stale shas, fails, or raises, the client fails
          closed and raises the original ``StaleVectorError``.

        The retry budget is bounded: at most ``max_attempts`` HTTP attempts.
        Authentication failures (``TokenExpiredError`` / ``TokenRevokedError``)
        are never retried.

        Args:
            payload: CONTRACT v0.1 check payload dictionary (not mutated).
            runner_token: Optional runner bearer token (defaults to $RUNNER_TOKEN);
                used both for POST /checks and the authenticated resync read.
            max_attempts: Total attempts including the first (must be >= 1).
            recompute_fn: Optional callback ``recompute_fn(current_heads) -> payload``
                that re-evaluates the checks at the fresh head vector.

        Returns:
            Coordinator response dict on success.

        Raises:
            ValueError: If payload fails validation or max_attempts < 1.
            StaleVectorError: If the vector remains stale (no recompute_fn,
                recompute failed/invalid, or retry budget exhausted). The
                exception carries ``fresh_vector`` when the current heads were
                fetched successfully.
            TokenExpiredError / TokenRevokedError: On credential rejection (never retried).
            AgentBranchesAPIError: On other API errors.
        """
        if max_attempts < 1:
            raise ValueError("max_attempts must be >= 1")
        if not isinstance(payload, dict):
            raise ValueError("checks payload must be a JSON dictionary")

        attempt_payload = copy.deepcopy(payload)
        stale_exc: Optional[StaleVectorError] = None

        for attempt in range(max_attempts):
            try:
                return self.send_checks(attempt_payload, runner_token=runner_token)
            except StaleVectorError as exc:
                stale_exc = exc
                # Always try to attach the coordinator's current heads so the
                # caller can re-evaluate explicitly, even when we fail closed.
                fresh_heads: Optional[Dict[str, str]] = None
                try:
                    fresh_heads = self.refresh_head_vector(runner_token=runner_token)
                except AgentBranchesError:
                    fresh_heads = None  # resync source unreachable: fail closed
                if fresh_heads is not None:
                    exc.fresh_vector = fresh_heads

                if attempt >= max_attempts - 1 or fresh_heads is None:
                    break
                if recompute_fn is None:
                    break  # no re-evaluation callback: fail closed, never replay
                original_vector = attempt_payload.get("vector")
                if not isinstance(original_vector, dict) or not original_vector:
                    break
                if any(key not in fresh_heads for key in original_vector):
                    break  # missing participant: fail closed, never retry with a pruned vector
                try:
                    recomputed = recompute_fn(dict(fresh_heads))
                except Exception:
                    break  # recompute failed: fail closed, stale results never replayed
                validated = self._validated_recomputed_payload(
                    original_vector, fresh_heads, recomputed
                )
                if validated is None:
                    break  # invalid recompute: fail closed
                attempt_payload = copy.deepcopy(validated)

        assert stale_exc is not None
        raise stale_exc


    # MCP-compatible aliases (CONTRACT-L2-L3 Section 2.2)
    def branches_create_task(
        self,
        repo: str,
        base_sha: str,
        intent: str,
        branch: str,
        admin_token: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self.create_task(
            repo=repo,
            base_sha=base_sha,
            intent=intent,
            branch=branch,
            admin_token=admin_token,
        )

    def branches_push_wip(
        self,
        task_id: str,
        head_sha: str,
        intent_update: Optional[str] = None,
        test_provenance: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self.push(
            task_id=task_id,
            head_sha=head_sha,
            intent=intent_update,
            test_provenance=test_provenance,
            agent_id=agent_id,
        )

    def branches_push_batch(
        self,
        events: List[Dict[str, Any]],
        token: Optional[str] = None,
        max_retries: int = 3,
        retry_backoff: float = 0.05,
    ) -> List[Dict[str, Any]]:
        return self.push_batch(
            events=events,
            token=token,
            max_retries=max_retries,
            retry_backoff=retry_backoff,
        )

    def branches_get_status(self, task_id: Optional[str] = None) -> Dict[str, Any]:
        if task_id:
            return self.get_task(task_id)
        return self.get_status()

    def branches_ack_warning(
        self, task_id: str, warning_id: str, action: str = "rebased_locally"
    ) -> Dict[str, Any]:
        return self.ack_warning(warning_id=warning_id, task_id=task_id, action=action)
