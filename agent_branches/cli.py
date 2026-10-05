"""Command-line interface for agent-branches."""

import argparse
import json
import os
import sys
from typing import List, Optional

from agent_branches.client import (
    AgentBranchesAPIError,
    AgentBranchesClient,
    AgentBranchesConnectionError,
    AgentBranchesError,
    BatchExecutionError,
    StaleVectorError,
    TokenExpiredError,
    TokenRevokedError,
)

from agent_branches.git_utils import (
    get_changed_files,
    get_current_branch,
    get_current_head_sha,
    get_remote_url,
)


def format_task_created(res: dict) -> str:
    """Format task creation response."""
    task_id = res.get("taskId") or res.get("id") or res.get("task_id") or "unknown"
    agent_id = res.get("agentId") or res.get("agent_id") or res.get("agent") or ""
    fork_url = ""
    fork = res.get("fork")
    if isinstance(fork, dict):
        fork_url = fork.get("remote") or fork.get("name") or ""
    elif isinstance(fork, str):
        fork_url = fork
    if not fork_url:
        fork_url = res.get("fork_url") or res.get("forkUrl") or ""

    branch = res.get("branch") or res.get("ref", "").replace("refs/heads/", "")
    head = res.get("head") or res.get("head_sha") or res.get("base_sha") or "N/A"

    lines = [
        "========================================",
        "  TASK REGISTERED SUCCESSFULLY",
        "========================================",
        f"  Task ID:   {task_id}",
    ]
    if agent_id:
        lines.append(f"  Agent ID:  {agent_id}")
    if branch:
        lines.append(f"  Branch:    {branch}")
    if fork_url:
        lines.append(f"  Fork URL:  {fork_url}")
    lines.append(f"  Head SHA:  {head}")
    if res.get("intent"):
        lines.append(f"  Intent:    {res.get('intent')}")
    lines.append("========================================")
    return "\n".join(lines)


def format_push_result(res: dict) -> str:
    """Format push event response."""
    task_id = res.get("task_id") or res.get("taskId") or ""
    agent_id = res.get("agent_id") or res.get("agentId") or res.get("agent") or ""
    head_sha = res.get("head_sha") or res.get("sha") or "unknown"
    accepted = res.get("accepted", False)
    deduped = res.get("deduped", False)
    checks = res.get("radar_checks", res.get("radarChecks", 0))
    new_warnings = res.get("new_warnings", res.get("newWarnings", []))

    lines = [
        "========================================",
        "  WIP COMMIT PUSH REGISTERED",
        "========================================",
    ]
    if task_id:
        lines.append(f"  Task ID:      {task_id}")
    if agent_id:
        lines.append(f"  Agent ID:     {agent_id}")
    lines.extend([
        f"  Head SHA:     {head_sha}",
        f"  Accepted:     {accepted}",
        f"  Deduped:      {deduped}",
        f"  Radar Checks: {checks}",
    ])

    if new_warnings:
        lines.append(f"\n  WARNING: {len(new_warnings)} conflict warning(s) detected!")
        for w in new_warnings:
            wid = w.get("warning_id") or w.get("id") or "unknown"
            kind = w.get("kind", "textual")
            pair = w.get("pair", [])
            evidence = w.get("evidence", {})
            files = evidence.get("conflicting_files", []) if isinstance(evidence, dict) else []
            lines.append(f"  - [{wid}] ({kind}) Pair: {pair}")
            if files:
                lines.append(f"    Conflicting files: {', '.join(files)}")
            if isinstance(evidence, dict) and evidence.get("details"):
                lines.append(f"    Details: {evidence.get('details')}")
    else:
        lines.append("  Status:       Clean (no new conflict warnings)")

    lines.append("========================================")
    return "\n".join(lines)


def format_status_result(res: dict, task_id: Optional[str] = None) -> str:
    """Format status response (either task-specific or global)."""
    lines = ["========================================"]

    if task_id or "task_id" in res or "taskId" in res:
        # Task-specific status
        tid = res.get("task_id") or res.get("taskId") or task_id
        lines.append(f"  TASK STATUS: {tid}")
        lines.append("========================================")
        status_val = res.get("status", "active")
        branch = res.get("branch") or res.get("ref", "").replace("refs/heads/", "")
        head = res.get("head_sha") or res.get("head") or "N/A"
        agent = res.get("agent_id") or res.get("agentId") or res.get("agent") or ""
        lines.append(f"  Status:    {status_val}")
        if agent:
            lines.append(f"  Agent ID:  {agent}")
        if branch:
            lines.append(f"  Branch:    {branch}")
        lines.append(f"  Head SHA:  {head}")
        if res.get("intent"):
            lines.append(f"  Intent:    {res.get('intent')}")
        if res.get("test_provenance"):
            lines.append(f"  Tests:     {res.get('test_provenance')}")

        warnings = res.get("warnings", [])
        active_warnings = [w for w in warnings if w.get("status") == "active"]
        if active_warnings:
            lines.append(f"\n  Active Radar Warnings ({len(active_warnings)}):")
            for w in active_warnings:
                wid = w.get("warning_id") or w.get("id") or "unknown"
                kind = w.get("kind", "textual")
                pair = w.get("pair", [])
                evidence = w.get("evidence", {})
                files = evidence.get("conflicting_files", []) if isinstance(evidence, dict) else []
                lines.append(f"  * [{wid}] ({kind}) Overlap with: {pair}")
                if files:
                    lines.append(f"    Conflicting files: {', '.join(files)}")
                lines.append(
                    f"    Resolution: run `agent-branches ack --task-id {tid} --warning-id {wid} --action rebased_locally`"
                )
        else:
            lines.append("\n  Radar Warnings: None (Clean)")

    else:
        # Global coordinator status
        lines.append("  RADAR / COORDINATOR STATUS")
        lines.append("========================================")
        canonical = res.get("canonical", {})
        if isinstance(canonical, dict):
            c_name = canonical.get("name") or "canonical"
            lines.append(f"  Canonical: {c_name}")

        tasks = res.get("tasks", [])
        lines.append(f"  Active Tasks ({len(tasks)}):")
        for t in tasks:
            tid = t.get("task_id") or t.get("taskId") or t.get("id") or "unknown"
            t_agent = t.get("agent_id") or t.get("agentId") or t.get("agent") or ""
            tbranch = t.get("branch") or t.get("ref", "").replace("refs/heads/", "")
            thead = (t.get("head_sha") or t.get("head") or "")[:8]
            agent_str = f", agent: {t_agent}" if t_agent else ""
            lines.append(f"    - {tid} (branch: {tbranch or 'main'}, head: {thead}{agent_str})")

        warnings = res.get("warnings", [])
        active_warnings = [w for w in warnings if w.get("status") == "active"]
        if active_warnings:
            lines.append(f"\n  Active Warnings ({len(active_warnings)}):")
            for w in active_warnings:
                wid = w.get("warning_id") or w.get("id") or "unknown"
                pair = w.get("pair", [])
                kind = w.get("kind", "textual")
                lines.append(f"    * [{wid}] ({kind}) Pair: {pair}")
        else:
            lines.append("\n  Active Warnings: None (Clean)")

    lines.append("========================================")
    return "\n".join(lines)


def format_ack_result(res: dict) -> str:
    """Format warning acknowledgement response."""
    wid = res.get("warning_id") or res.get("id") or "unknown"
    tid = res.get("task_id") or res.get("taskId") or "unknown"
    action = res.get("action") or "acknowledged"
    time_str = res.get("acknowledged_at") or "now"

    return "\n".join([
        "========================================",
        "  WARNING ACKNOWLEDGED",
        "========================================",
        f"  Warning ID: {wid}",
        f"  Task ID:    {tid}",
        f"  Action:     {action}",
        f"  Time:       {time_str}",
        "========================================",
    ])


def format_checks_result(res: dict) -> str:

    """Format checks submission response."""
    accepted = res.get("accepted", 0)
    pairs = res.get("pairs", [])
    created = res.get("createdWarnings", [])

    lines = [
        "========================================",
        "  RADAR CHECKS SUBMITTED (CONTRACT v0.1)",
        "========================================",
        f"  Accepted:  {accepted} check(s)",
        f"  Pairs:     {len(pairs)}",
        f"  Warnings:  {len(created)} created",
    ]
    if created:
        lines.append("\n  New Warning(s):")
        for w in created:
            wid = w.get("id") or w.get("warning_id") or "unknown"
            status = w.get("status", "active")
            reason = w.get("reason", "unknown")
            lines.append(f"  - [{wid}] ({status}) {reason}")
    lines.append("========================================")
    return "\n".join(lines)


def format_batch_error_receipt(err: BatchExecutionError) -> str:
    """Format structured failure receipt for BatchExecutionError."""
    lines = [
        f"Error: Batch push failed at event index {err.failed_index}",
        f"Underlying cause: {err.original_error}",
        f"Ambiguous event (mutation status unconfirmed): {err.ambiguous_event}",
        f"Succeeded events ({len(err.succeeded)}): {json.dumps(err.succeeded) if err.succeeded else 'none'}",
        f"Unattempted events ({len(err.unattempted_events)}): {json.dumps(err.unattempted_events) if err.unattempted_events else 'none'}",
        "Invocation Guarantee: Succeeded events in this batch invocation were committed and not replayed. To resume without duplicate mutation, operator must dispatch only unattempted_events.",
    ]
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:

    """Construct argument parser for agent-branches CLI."""
    parser = argparse.ArgumentParser(
        prog="agent-branches",
        description="L2 Agent Client CLI for Cloudflare Agent Branches",
    )
    parser.add_argument(
        "--server",
        help="L1 Coordinator server URL (default: $AGENT_BRANCHES_SERVER or http://127.0.0.1:8787)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output raw JSON response",
    )

    subparsers = parser.add_subparsers(dest="command", help="Available subcommands")

    # task command
    task_parser = subparsers.add_parser("task", help="Task operations")
    task_sub = task_parser.add_subparsers(dest="task_action", help="Task actions")

    task_create = task_sub.add_parser("create", help="Register a new task")
    task_create.add_argument("--repo", help="Repository URL (defaults to git remote origin)")
    task_create.add_argument("--base-sha", help="Base commit SHA (defaults to git HEAD)")
    task_create.add_argument("--intent", default="", help="High-level task intent description")
    task_create.add_argument("--branch", help="Working branch name (defaults to git branch)")
    task_create.add_argument("--agent", help="Agent identifier / name prefix")
    task_create.add_argument("--ttl-seconds", type=int, help="Fork token TTL in seconds")
    task_create.add_argument(
        "--admin-token",
        help="Admin bearer token for authorized task creation (or $ADMIN_TOKEN)",
    )
    task_create.add_argument("--server", help="Coordinator URL")
    task_create.add_argument("--json", action="store_true", help="Output raw JSON")

    # push command
    push_parser = subparsers.add_parser("push", help="Register a WIP commit push")
    push_parser.add_argument("--task-id", help="Task identifier (used to resolve agent ID if omitted)")
    push_parser.add_argument("--agent-id", help="Explicit agent identifier required by L1 coordinator")
    push_parser.add_argument("--head-sha", help="WIP commit SHA (defaults to git HEAD)")
    push_parser.add_argument("--base-sha", help="Base commit SHA")
    push_parser.add_argument(
        "--files-changed",
        help="Comma-separated list of changed files (auto-detected via git if omitted)",
    )
    push_parser.add_argument(
        "--intent-update",
        help="Updated task intent description",
    )
    push_parser.add_argument(
        "--intent",
        dest="intent_update",
        help="Alias for --intent-update",
    )
    push_parser.add_argument(
        "--test-provenance",
        help="Test execution provenance evidence (e.g. 'vitest: 14 passed')",
    )
    push_parser.add_argument("--server", help="Coordinator URL")
    push_parser.add_argument("--json", action="store_true", help="Output raw JSON")

    # push-batch command
    push_batch_parser = subparsers.add_parser(
        "push-batch", help="Register a batch of WIP commit pushes"
    )
    push_batch_parser.add_argument(
        "--events-file",
        help="Path to JSON file containing array of push event objects",
    )
    push_batch_parser.add_argument(
        "--event",
        action="append",
        help="JSON string representing a single push event (can be specified multiple times)",
    )
    push_batch_parser.add_argument(
        "--max-retries",
        type=int,
        default=3,
        help="Compatibility parameter; push-batch operates pure fail-closed on mutating events without automatic retries",
    )
    push_batch_parser.add_argument(
        "--retry-backoff",
        type=float,
        default=0.05,
        help="Compatibility parameter; push-batch operates pure fail-closed on mutating events without automatic retries",
    )
    push_batch_parser.add_argument(
        "--token",
        help="Bearer token for push events (or $TASK_TOKEN / $AGENT_TOKEN)",
    )
    push_batch_parser.add_argument(
        "--admin-token",
        help="Admin bearer token for authorized pushes (or $ADMIN_TOKEN)",
    )
    push_batch_parser.add_argument("--server", help="Coordinator URL")
    push_batch_parser.add_argument("--json", action="store_true", help="Output raw JSON")

    # status command
    status_parser = subparsers.add_parser("status", help="Query coordinator and radar status")
    status_parser.add_argument(
        "--task-id", help="Task ID to query specific task status and active warnings"
    )
    status_parser.add_argument("--server", help="Coordinator URL")
    status_parser.add_argument("--json", action="store_true", help="Output raw JSON")

    # ack command
    ack_parser = subparsers.add_parser("ack", help="Acknowledge an active radar conflict warning")
    ack_parser.add_argument(
        "--task-id", required=True, help="Task identifier acknowledging the warning"
    )
    ack_parser.add_argument(
        "--warning-id", required=True, help="Warning identifier being acknowledged"
    )
    ack_parser.add_argument(
        "--action",
        default="rebased_locally",
        help="Action taken to address warning (e.g. 'rebased_locally', 'manual_merge')",
    )
    ack_parser.add_argument("--server", help="Coordinator URL")
    ack_parser.add_argument("--json", action="store_true", help="Output raw JSON")

    # checks command (CONTRACT v0.1)
    checks_parser = subparsers.add_parser(
        "checks", help="Submit radar check results (CONTRACT v0.1)"
    )
    checks_parser.add_argument(
        "--file",
        help="Path to JSON checks payload file (reads from stdin if omitted)",
    )
    checks_parser.add_argument(
        "--runner-token",
        help="Runner bearer token for check submission (or $RUNNER_TOKEN)",
    )
    checks_parser.add_argument("--server", help="Coordinator URL")
    checks_parser.add_argument("--json", action="store_true", help="Output raw JSON")

    # sync command
    sync_parser = subparsers.add_parser("sync", help="Synchronize working changes")
    sync_sub = sync_parser.add_subparsers(dest="sync_action", help="Sync actions")
    git_sync = sync_sub.add_parser("git", help="Sanitized checkpoint and push working changes to Git")
    git_sync.add_argument("--message", "-m", help="Commit message for the checkpoint")
    git_sync.add_argument("--preview", action="store_true", help="Preview changes without committing or pushing")
    git_sync.add_argument("--remote", default="origin", help="Git remote name (default: origin)")
    git_sync.add_argument("--repo-dir", default=".", help="Path to repository directory (default: current directory)")
    git_sync.add_argument("--json", action="store_true", help="Output raw JSON")

    return parser



def handle_task_create(args: argparse.Namespace, client: AgentBranchesClient, as_json: bool) -> int:
    repo = args.repo or get_remote_url()
    if not repo:
        repo = "https://github.com/agent-branches/repo.git"

    base_sha = args.base_sha or get_current_head_sha()
    if not base_sha:
        base_sha = "0000000000000000000000000000000000000000"

    branch = args.branch or get_current_branch() or "feat/task"
    intent = args.intent or ""
    agent = getattr(args, "agent", None)
    ttl = getattr(args, "ttl_seconds", None)
    admin_token = getattr(args, "admin_token", None) or os.environ.get("ADMIN_TOKEN")

    res = client.create_task(
        repo=repo,
        base_sha=base_sha,
        intent=intent,
        branch=branch,
        agent=agent,
        ttl_seconds=ttl,
        admin_token=admin_token,
    )
    if as_json:
        print(json.dumps(res, indent=2))
    else:
        print(format_task_created(res))
    return 0


def handle_push(args: argparse.Namespace, client: AgentBranchesClient, as_json: bool) -> int:
    task_id = getattr(args, "task_id", None)
    agent_id = getattr(args, "agent_id", None)

    if not task_id and not agent_id:
        print("Error: either --task-id or --agent-id must be specified", file=sys.stderr)
        return 2

    head_sha = args.head_sha or get_current_head_sha()
    if not head_sha:
        print("Error: --head-sha is required when not in a valid git repository", file=sys.stderr)
        return 1

    files_changed: Optional[List[str]] = None
    if args.files_changed:
        files_changed = [f.strip() for f in args.files_changed.split(",") if f.strip()]
    elif args.base_sha:
        files_changed = get_changed_files(base_sha=args.base_sha, head_sha=head_sha)

    try:
        res = client.push(
            task_id=task_id,
            agent_id=agent_id,
            head_sha=head_sha,
            base_sha=args.base_sha,
            files_changed=files_changed,
            intent=args.intent_update,
            test_provenance=args.test_provenance,
        )
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    if as_json:
        print(json.dumps(res, indent=2))
    else:
        print(format_push_result(res))
    return 0


def cmd_push_batch(
    args: argparse.Namespace,
    client: Optional[AgentBranchesClient] = None,
    as_json: Optional[bool] = None,
) -> int:
    """Execute push-batch CLI subcommand."""
    if client is None:
        server_url = getattr(args, "server", None)
        client = AgentBranchesClient(server_url=server_url)
    if as_json is None:
        as_json = bool(getattr(args, "json", False))

    events: List[dict] = []

    # Read events from --events-file if specified
    events_file = getattr(args, "events_file", None)
    if events_file:
        try:
            with open(events_file, "r", encoding="utf-8") as f:
                file_content = f.read()
        except OSError as exc:
            print(f"Error reading events file '{events_file}': {exc}", file=sys.stderr)
            return 2

        try:
            file_events = json.loads(file_content)
        except json.JSONDecodeError as exc:
            print(f"Error parsing JSON from events file '{events_file}': {exc}", file=sys.stderr)
            return 2

        if not isinstance(file_events, list):
            print(
                f"Error: events file '{events_file}' must contain a JSON array of event objects",
                file=sys.stderr,
            )
            return 2
        events.extend(file_events)

    # Read events from repeatable --event if specified
    event_strings = getattr(args, "event", None)
    if event_strings:
        for ev_str in event_strings:
            try:
                ev_obj = json.loads(ev_str)
            except json.JSONDecodeError as exc:
                print(f"Error parsing --event JSON '{ev_str}': {exc}", file=sys.stderr)
                return 2

            if not isinstance(ev_obj, dict):
                print(
                    f"Error: --event must be a JSON object, got {type(ev_obj).__name__}",
                    file=sys.stderr,
                )
                return 2
            events.append(ev_obj)

    if not events_file and not event_strings:
        print(
            "Error: either --events-file or at least one --event must be specified",
            file=sys.stderr,
        )
        return 2

    if len(events) == 0:
        print("Error: events list cannot be empty", file=sys.stderr)
        return 2

    max_retries = getattr(args, "max_retries", None)
    if max_retries is None:
        max_retries = 3

    retry_backoff = getattr(args, "retry_backoff", None)
    if retry_backoff is None:
        retry_backoff = 0.05

    token = getattr(args, "token", None)
    admin_token = getattr(args, "admin_token", None)

    try:
        results = client.push_batch(
            events=events,
            token=token,
            admin_token=admin_token,
            max_retries=max_retries,
            retry_backoff=retry_backoff,
        )
    except (ValueError, TypeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    except BatchExecutionError as exc:
        if as_json:
            payload = {
                "error": "batch_push_failed",
                "failed_index": exc.failed_index,
                "original_error": str(exc.original_error),
                "ambiguous_event": exc.ambiguous_event,
                "succeeded": exc.succeeded,
                "unattempted_events": exc.unattempted_events,
                "guarantee": "Invocation Guarantee: Succeeded events in this batch invocation were committed and not replayed. To resume without duplicate mutation, operator must dispatch only unattempted_events.",
            }
            print(json.dumps(payload, indent=2), file=sys.stderr)
        else:
            print(format_batch_error_receipt(exc), file=sys.stderr)
        return 1

    print(json.dumps(results, indent=2))
    return 0


# Handler alias
handle_push_batch = cmd_push_batch


def handle_status(args: argparse.Namespace, client: AgentBranchesClient, as_json: bool) -> int:
    if args.task_id:
        res = client.get_task(args.task_id)
        if as_json:
            print(json.dumps(res, indent=2))
        else:
            print(format_status_result(res, task_id=args.task_id))
    else:
        res = client.get_status()
        if as_json:
            print(json.dumps(res, indent=2))
        else:
            print(format_status_result(res, task_id=None))
    return 0


def handle_ack(args: argparse.Namespace, client: AgentBranchesClient, as_json: bool) -> int:
    res = client.ack_warning(
        warning_id=args.warning_id,
        task_id=args.task_id,
        action=args.action,
    )
    if as_json:
        print(json.dumps(res, indent=2))
    else:
        print(format_ack_result(res))
    return 0


def handle_checks(args: argparse.Namespace, client: AgentBranchesClient, as_json: bool) -> int:
    payload_raw = None
    if getattr(args, "file", None):
        try:
            with open(args.file, "r", encoding="utf-8") as f:
                payload_raw = f.read()
        except OSError as exc:
            print(f"Error reading file '{args.file}': {exc}", file=sys.stderr)
            return 1
    else:
        if sys.stdin.isatty():
            print("Error: specify --file <payload.json> or pipe JSON to stdin", file=sys.stderr)
            return 1
        payload_raw = sys.stdin.read()

    try:
        payload = json.loads(payload_raw)
    except json.JSONDecodeError as exc:
        print(f"Error parsing JSON payload: {exc}", file=sys.stderr)
        return 1

    runner_token = getattr(args, "runner_token", None) or os.environ.get("RUNNER_TOKEN")

    try:
        res = client.send_checks(payload, runner_token=runner_token)
    except StaleVectorError as exc:
        if as_json:
            print(
                json.dumps(
                    {
                        "error": "stale_vector",
                        "status_code": 409,
                        "message": exc.message,
                        "details": exc.payload,
                    },
                    indent=2,
                ),
                file=sys.stderr,
            )
        else:
            print(f"Conflict Error (409): Stale vector - {exc.message}", file=sys.stderr)
            if exc.payload:
                print(f"Details: {exc.payload}", file=sys.stderr)
        return 1
    except TokenExpiredError as exc:
        print(
            f"Authentication Error ({exc.status_code}): Bearer token expired - "
            f"credentials reported expired by coordinator. Halting (no retry). "
            f"Refresh the token and try again. Details: {exc.message}",
            file=sys.stderr,
        )
        return 1
    except TokenRevokedError as exc:
        print(
            f"Authentication Error ({exc.status_code}): Bearer token revoked - "
            f"failing closed, retrying cannot succeed. "
            f"Issuer a new token. Details: {exc.message}",
            file=sys.stderr,
        )
        return 1
    except (ValueError, AgentBranchesAPIError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    if as_json:
        print(json.dumps(res, indent=2))
    else:
        print(format_checks_result(res))
    return 0


def handle_sync_git(args: argparse.Namespace, as_json: bool) -> int:
    from agent_branches.sync_git import sync_git, SyncGitError
    repo_dir = getattr(args, "repo_dir", ".") or "."
    message = getattr(args, "message", None)
    preview = bool(getattr(args, "preview", False))
    remote = getattr(args, "remote", "origin") or "origin"

    try:
        res = sync_git(repo_dir=repo_dir, message=message, preview=preview, remote=remote)
        if as_json:
            print(json.dumps(res, indent=2))
        else:
            status = res.get("status")
            if status == "preview":
                print(f"[PREVIEW] Branch: {res.get('branch')}")
                print(f"  To stage ({res.get('to_stage_count')} files):")
                for f in res.get("modified_tracked", []):
                    print(f"    modified: {f}")
                for f in res.get("untracked_safe_to_add", []):
                    print(f"    untracked safe: {f}")
                if res.get("ignored_forbidden"):
                    print("  Ignored private/sensitive:")
                    for f in res.get("ignored_forbidden", []):
                        print(f"    ignored: {f}")
            elif status == "noop":
                print(f"[NOOP] {res.get('message')}")
                print(f"  Branch: {res.get('branch')} (HEAD: {res.get('head_sha')[:8]})")
            elif status == "synced":
                print(f"[SYNCED] Checkpoint committed and pushed successfully.")
                print(f"  Branch: {res.get('branch')}")
                print(f"  Commit: {res.get('head_sha')}")
                print(f"  Remote SHA: {res.get('remote_sha')} (verified: {res.get('verified')})")
                print(f"  Files: {len(res.get('staged_files', []))} committed")
        return 0
    except SyncGitError as e:
        if as_json:
            print(json.dumps({"error": str(e), "status": "failed"}, indent=2))
        else:
            print(f"Error: {e}", file=sys.stderr)
        return 1


def main(argv: Optional[List[str]] = None) -> int:
    """Main CLI entrypoint."""
    parser = build_parser()
    args = parser.parse_args(argv)

    if not args.command:
        parser.print_help()
        return 1

    server_url = getattr(args, "server", None)
    as_json = bool(getattr(args, "json", False))
    client = AgentBranchesClient(server_url=server_url)

    try:
        if args.command == "task":
            if getattr(args, "task_action", None) == "create":
                return handle_task_create(args, client, as_json)
            else:
                parser.parse_args(["task", "--help"])
                return 1
        elif args.command == "push":
            return handle_push(args, client, as_json)
        elif args.command == "push-batch":
            return cmd_push_batch(args, client, as_json)
        elif args.command == "status":
            return handle_status(args, client, as_json)
        elif args.command == "ack":
            return handle_ack(args, client, as_json)
        elif args.command == "checks":
            return handle_checks(args, client, as_json)
        elif args.command == "sync":
            if getattr(args, "sync_action", None) == "git":
                return handle_sync_git(args, as_json)
            else:
                parser.parse_args(["sync", "--help"])
                return 1
        else:
            parser.print_help()
            return 1
    except AgentBranchesConnectionError as exc:
        print(f"Connection Error: {exc}", file=sys.stderr)
        return 2
    except StaleVectorError as exc:
        print(f"Conflict Error (409): Stale vector - {exc.message}", file=sys.stderr)
        return 1
    except BatchExecutionError as exc:
        if as_json:
            payload = {
                "error": "batch_push_failed",
                "failed_index": exc.failed_index,
                "original_error": str(exc.original_error),
                "ambiguous_event": exc.ambiguous_event,
                "succeeded": exc.succeeded,
                "unattempted_events": exc.unattempted_events,
                "guarantee": "Invocation Guarantee: Succeeded events in this batch invocation were committed and not replayed. To resume without duplicate mutation, operator must dispatch only unattempted_events.",
            }
            print(json.dumps(payload, indent=2), file=sys.stderr)
        else:
            print(format_batch_error_receipt(exc), file=sys.stderr)
        return 1
    except TokenExpiredError as exc:
        print(
            f"Authentication Error ({exc.status_code}): Bearer token expired - "
            f"credentials reported expired by coordinator. Halting (no retry). "
            f"Refresh the token and try again. Details: {exc.message}",
            file=sys.stderr,
        )
        return 1
    except TokenRevokedError as exc:
        print(
            f"Authentication Error ({exc.status_code}): Bearer token revoked - "
            f"failing closed, retrying cannot succeed. "
            f"Issuer a new token. Details: {exc.message}",
            file=sys.stderr,
        )
        return 1
    except AgentBranchesAPIError as exc:
        print(f"API Error ({exc.status_code}): {exc.message}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1



if __name__ == "__main__":
    sys.exit(main())
