/**
 * Coordinator core (facade extraction, 2026-10-03): ALL coordination logic
 * — task registry, head vectors, push dedup, warnings, checks validation,
 * the stale-vector rule and credential decisions — as pure TypeScript with
 * NO Cloudflare imports. It talks to the world only through the ports in
 * src/ports/ (GitHost, CoordinationStore, Radar, Clock, IdGenerator), so
 * the same class runs inside a Cloudflare Durable Object, a plain Node
 * process, or tests with in-memory fakes.
 *
 * The Durable Object wrapper lives in src/cloudflare/coordinator-do.ts;
 * the local Node runtime in src/local/.
 */

import type { CoordinationStore } from "../ports/coordination-store.js";
import type { Clock, IdGenerator } from "../ports/clock.js";
import type { GitHost } from "../ports/githost.js";
import type {
  ChecksCoverageCounts,
  ChecksPolicySpec,
  NormalizedCheckResult,
  NormalizedChecksPayload,
} from "../checks-wire.js";
import { RADAR_STATUSES, pairKey, type Radar, type RadarPairResult, type RadarStatus } from "../radar.js";
import type { UnprocessedPush } from "../ports/githost.js";
import {
  CANONICAL_BASE,
  RADAR_LOG_CAP,
  SEEN_PUSHES_CAP_PER_AGENT,
  WARNINGS_CAP,
  emptyModel,
  migrateStoredModel,
  type AgentRecord,
  type CoordinatorModel,
  type PairCheckRecord,
  type PairStatusView,
  type RadarLogEntry,
  type RunnerReport,
  type TaskRecord,
  type TestProvenance,
  type WarningRecord,
} from "./model.js";
import { sha256Hex, timingSafeEqual } from "./auth.js";

const MODEL_KEY = "model";

export interface CoordinatorPorts {
  store: CoordinationStore;
  git: GitHost;
  radar: Radar;
  clock: Clock;
  ids: IdGenerator;
}

export interface SetupResult {
  canonical: { name: string; remote: string };
  created: boolean;
  seedCommit: string | null;
}

export interface CreateTaskInput {
  agent?: string;
  intent?: string;
  baseSha?: string;
  ttlSeconds?: number;
}

export interface CreateTaskResult {
  taskId: string;
  agentId: string;
  fork: { name: string; remote: string };
  ref: string;
  base_sha: string;
  intent: string | null;
  token: { scope: string; expiresAt: string; plaintext: string };
  head: string | null;
}

export interface RecordPushInput {
  agent?: string;
  fork?: string;
  ref?: string;
  sha: string;
}

export interface RecordPushResult {
  accepted: boolean;
  deduped: boolean;
  agent: string;
  heads: Record<string, string>;
  invalidatedWarnings: string[];
  newWarnings: WarningRecord[];
  radarChecks: number;
}

export interface StatusResult {
  canonical: { name: string | null; remote: string | null };
  /** Agent card view: the stored AgentRecord plus the owning task's intent
   * and baseSha (codex C-1306), so GET /status consumers see what each
   * agent is doing and which commit it started from without a per-task
   * round trip. Additive fields on the 0.1.2 wire; values mirror the
   * TaskRecord (null = not stated / not recorded, the UI's muted case). */
  agents: (AgentRecord & { intent: string | null; baseSha: string | null })[];
  heads: Record<string, string>;
  pairs: PairStatusView[];
  warnings: WarningRecord[];
  radarLog: RadarLogEntry[];
  lastRunnerReport: RunnerReport | null;
  /** codex C-1357: pushes the Worker never accepted (callback lost). */
  unprocessedPushes: (UnprocessedPush & { agentId: string | null })[];
}

export interface TaskDetail extends TaskRecord {
  base_sha: string;
  agent: AgentRecord | null;
  head: string | null;
  pushes: number;
  warnings: WarningRecord[];
  testProvenance: TestProvenance | null;
}

export interface SubmitChecksResult {
  stale: false;
  accepted: number;
  pairs: PairStatusView[];
  createdWarnings: WarningRecord[];
  currentHeads: Record<string, string>;
  runnerReport: RunnerReport;
}

export interface StaleChecksResult {
  stale: true;
  currentHeads: Record<string, string>;
}

/**
 * The surface any runtime exposes to the router. The Cloudflare adapter
 * satisfies it with a Durable Object RPC stub; the local runtime passes
 * the CoordinatorCore directly.
 */
export interface CoordinatorAccess {
  setup(): Promise<SetupResult>;
  createTask(input: CreateTaskInput): Promise<CreateTaskResult>;
  recordPush(input: RecordPushInput): Promise<RecordPushResult>;
  status(): Promise<StatusResult>;
  getTask(taskId: string): Promise<TaskDetail>;
  ackWarning(warningId: string, input: { agent: string; note?: string }): Promise<{ warning: WarningRecord }>;
  recordTestProvenance(
    taskId: string,
    input: { command: string; exit: number; head_sha: string },
  ): Promise<{ testProvenance: TestProvenance }>;
  submitChecks(input: NormalizedChecksPayload): Promise<SubmitChecksResult | StaleChecksResult>;
  credentialAgent(presented: string, nowMs?: number): Promise<string | null>;
  revokeAgentToken(agentId: string, revokedAt?: string): Promise<boolean>;
  taskOwner(taskId: string): Promise<string | null>;
  forkOwner(fork: string): Promise<string | null>;
}

/**
 * muse-r46 D1: a pair may arrive in either agent order ([a,b] or [b,a]);
 * canonicalize the pair AND its per-slot heads (same a <= b rule as pairKey)
 * so both orders map to ONE pairChecks record and at most ONE active
 * warning for a pair at a given head vector.
 */
function canonicalPairHeads(
  pair: readonly [string, string],
  heads: { a: string; b: string },
): { pair: [string, string]; heads: { a: string; b: string } } {
  return pair[0] <= pair[1]
    ? { pair: [pair[0], pair[1]], heads: { a: heads.a, b: heads.b } }
    : { pair: [pair[1], pair[0]], heads: { a: heads.b, b: heads.a } };
}

export class CoordinatorCore implements CoordinatorAccess {
  private model: CoordinatorModel | null = null;
  /**
   * Serializes mutating RPC methods (codex C-1305 #4): workerd can deliver
   * concurrent events while a method awaits sidecar/binding I/O, which would
   * otherwise race seq allocation and cause duplicate forks or lost updates.
   */
  private mutex: Promise<unknown> = Promise.resolve();

  constructor(private readonly ports: CoordinatorPorts) {}

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn, fn);
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<CoordinatorModel> {
    if (this.model) {
      return this.model;
    }
    const stored = (await this.ports.store.get<CoordinatorModel>(MODEL_KEY)) as CoordinatorModel | undefined;
    this.model = migrateStoredModel(stored);
    return this.model;
  }

  private async persist(): Promise<void> {
    await this.ports.store.put(MODEL_KEY, this.model);
  }

  private async setupNow(): Promise<SetupResult> {
    const model = await this.load();
    if (model.canonicalName) {
      return {
        canonical: { name: model.canonicalName, remote: model.canonicalRemote ?? "" },
        created: false,
        seedCommit: null,
      };
    }
    const git = this.ports.git;
    // Per-instance suffix so isolated storage (tests) never collides on the
    // sidecar's on-disk repo namespace.
    const name = `${CANONICAL_BASE}-${this.ports.ids.suffix()}`;
    const created = await git.createRepo(name, {
      description: "Agent Branches canonical baseline",
      setDefaultBranch: "main",
    });
    const seed = await git.headCommit(created.name);
    model.canonicalName = created.name;
    model.canonicalRemote = created.remote;
    await this.persist();
    return {
      canonical: { name: created.name, remote: created.remote },
      created: true,
      seedCommit: seed,
    };
  }

  private async createTaskNow(input: CreateTaskInput): Promise<CreateTaskResult> {
    const model = await this.load();
    if (!model.canonicalName) {
      await this.setupNow();
    }
    const canonical = model.canonicalName!;
    const git = this.ports.git;
    const canonicalHead = await git.headCommit(canonical);
    const baseSha = input.baseSha ?? canonicalHead ?? "";
    if (!/^[0-9a-f]{40}$/.test(baseSha)) {
      throw new Error(`base_sha must be a 40-hex commit id (got invalid value)`);
    }
    if (baseSha !== canonicalHead) {
      // Verify the requested base exists in the canonical first-parent
      // history (documented log op; capped at its max limit).
      const history = await git.log(canonical, { limit: 1000 });
      if (!history.some((commit) => commit.id === baseSha)) {
        throw new Error(`base_sha ${baseSha} not found in canonical history`);
      }
    }
    model.seq += 1;
    const seq = String(model.seq).padStart(4, "0");
    const slug = (input.agent ?? "agent")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent";
    const agentId = `${slug}-${seq}`;
    const taskId = `task-${seq}`;
    const forkName = `${canonical}-${agentId}`;
    const fork = await git.fork(canonical, forkName, {
      description: `Agent Branches fork for ${agentId}`,
      defaultBranchOnly: true,
      baseSha,
    });
    // muse-r46 D3: real mode may not honor the requested base (the binding
    // forks the default branch, ASSUMED-F); record the REALIZED base.
    const effectiveBaseSha = fork.baseSha ?? baseSha;
    const token = await git.mintToken(forkName, "write", input.ttlSeconds ?? 3600);
    // muse-r46 AUTH: store only the digest for later verification of
    // agent-authenticated routes (/events/push, /tasks/:id/tests, acks).
    const tokenHash = await sha256Hex(token.plaintext);
    model.agentTokenHashes[agentId] = tokenHash;
    model.agentTokens[agentId] = {
      hash: tokenHash,
      expiresAt: token.expiresAt,
      revokedAt: null,
    };
    const forkLog = await git.log(forkName, { limit: 1 });
    const head = forkLog[0]?.id ?? null;
    const ref = "refs/heads/main";
    const now = this.ports.clock.iso();
    model.agents[agentId] = {
      agentId,
      taskId,
      forkName,
      forkRemote: fork.remote,
      ref,
      head,
      pushes: 0,
      createdAt: now,
      lastPushAt: null,
    };
    model.tasks[taskId] = {
      taskId,
      agentId,
      forkName,
      forkRemote: fork.remote,
      ref,
      createdAt: now,
      baseSha: effectiveBaseSha,
      intent: input.intent ?? null,
      testProvenance: null,
    };
    if (head) {
      const before = model.heads[agentId] ?? null;
      model.heads[agentId] = head;
      this.runRadar(model, { agent: agentId, ref, sha: head, before });
    }
    await this.persist();
    return {
      taskId,
      agentId,
      fork: { name: forkName, remote: fork.remote },
      ref,
      base_sha: effectiveBaseSha,
      intent: input.intent ?? null,
      token: { scope: token.scope, expiresAt: token.expiresAt, plaintext: token.plaintext },
      head,
    };
  }

  private async recordPushNow(input: RecordPushInput): Promise<RecordPushResult> {
    const model = await this.load();
    // The sidecar webhook posts {fork, ref, sha} without an agent id; resolve
    // the owning agent from the fork (codex C-1309 #7a).
    let agentRecord = input.agent ? model.agents[input.agent] : undefined;
    if (!agentRecord && input.fork) {
      agentRecord = Object.values(model.agents).find(
        (candidate) => candidate.forkName === input.fork || candidate.forkRemote === input.fork,
      );
    }
    if (!agentRecord) {
      throw new Error(`unknown agent: ${input.agent ?? input.fork}`);
    }
    const agentId = agentRecord.agentId;
    if (input.fork && input.fork !== agentRecord.forkName && input.fork !== agentRecord.forkRemote) {
      throw new Error(`fork ${input.fork} does not belong to agent ${agentId}`);
    }
    const dedupKey = `${agentId}:${input.sha}`;
    // muse-r46 D2: bounded per-agent ring instead of an ever-growing array
    // (the old `seenPushes.includes` was O(total pushes) per request).
    let seen = model.seenPushes[agentId];
    if (!seen) {
      seen = model.seenPushes[agentId] = [];
    }
    const deduped = seen.includes(dedupKey) || model.heads[agentId] === input.sha;
    if (deduped) {
      return {
        accepted: true,
        deduped: true,
        agent: agentId,
        // Snapshot: callers must never hold a live reference into the model.
        heads: { ...model.heads },
        invalidatedWarnings: [],
        newWarnings: [],
        radarChecks: 0,
      };
    }
    const git = this.ports.git;
    const known = await git.hasCommit(agentRecord.forkName, input.sha);
    if (!known) {
      throw new Error(`commit ${input.sha} not found in ${agentRecord.forkName}`);
    }
    const before = model.heads[agentId] ?? null;
    const ref = input.ref ?? agentRecord.ref;
    const now = this.ports.clock.iso();
    seen.push(dedupKey);
    if (seen.length > SEEN_PUSHES_CAP_PER_AGENT) {
      seen.splice(0, seen.length - SEEN_PUSHES_CAP_PER_AGENT);
    }
    model.heads[agentId] = input.sha;
    agentRecord.head = input.sha;
    agentRecord.pushes += 1;
    agentRecord.lastPushAt = now;
    agentRecord.ref = ref;
    const invalidatedWarnings = this.invalidateWarningsFor(model, agentId, now);
    const radarOutcome = this.runRadar(model, { agent: agentId, ref, sha: input.sha, before });
    const newWarnings = radarOutcome.created;
    await this.persist();
    return {
      accepted: true,
      deduped: false,
      agent: agentId,
      // Snapshot: callers must never hold a live reference into the model.
      heads: { ...model.heads },
      invalidatedWarnings,
      newWarnings,
      radarChecks: radarOutcome.checks.length,
    };
  }

  async status(): Promise<StatusResult> {
    const model = await this.load();
    const unprocessed = await this.unprocessedPushesSafe();
    const unprocessedAgents = new Set(
      unprocessed
        .map((push) => this.agentForFork(model, push.repo)?.agentId ?? null)
        .filter((agentId): agentId is string => agentId !== null),
    );
    return {
      canonical: { name: model.canonicalName, remote: model.canonicalRemote },
      agents: Object.values(model.agents).map((agent) => {
        const task = model.tasks[agent.taskId];
        return {
          ...agent,
          intent: task ? task.intent : null,
          baseSha: task ? task.baseSha : null,
        };
      }),
      // Snapshot: over RPC/wire this was always cloned; the direct core API
      // must not hand out the live heads object either.
      heads: { ...model.heads },
      pairs: this.pairViews(model, unprocessedAgents),
      warnings: [...model.warnings]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, 20),
      radarLog: [...model.radarLog].slice(-20).reverse(),
      lastRunnerReport: model.lastRunnerReport,
      unprocessedPushes: unprocessed.map((push) => ({
        ...push,
        agentId: this.agentForFork(model, push.repo)?.agentId ?? null,
      })),
    };
  }

  private agentForFork(model: CoordinatorModel, repo: string): AgentRecord | undefined {
    return Object.values(model.agents).find((agent) => agent.forkName === repo || agent.forkRemote === repo);
  }

  /**
   * codex C-1357: pulls the sidecar's callback-loss ledger. A failing or
   * absent ledger must never break /status — an unreadable guard degrades to
   * the pre-guard behavior, it does not fabricate certainty.
   */
  private async unprocessedPushesSafe(): Promise<UnprocessedPush[]> {
    try {
      return (await this.ports.git.unprocessedPushes?.()) ?? [];
    } catch {
      return [];
    }
  }

  async getTask(taskId: string): Promise<TaskDetail> {
    const model = await this.load();
    const task = model.tasks[taskId];
    if (!task) {
      throw new Error(`unknown task: ${taskId}`);
    }
    const agent = model.agents[task.agentId] ?? null;
    const warnings = model.warnings
      .filter((warning) => warning.pair.includes(task.agentId))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return {
      ...task,
      base_sha: task.baseSha,
      agent,
      head: agent?.head ?? null,
      pushes: agent?.pushes ?? 0,
      warnings,
      testProvenance: task.testProvenance,
    };
  }

  /** Record which agent acknowledged which warning at which head (C-1306). */
  private async ackWarningNow(
    warningId: string,
    input: { agent: string; note?: string },
  ): Promise<{ warning: WarningRecord }> {
    const model = await this.load();
    if (!(input.agent in model.agents)) {
      throw new Error(`unknown agent: ${input.agent}`);
    }
    const warning = model.warnings.find((candidate) => candidate.id === warningId);
    if (!warning) {
      throw new Error(`unknown warning: ${warningId}`);
    }
    warning.acks ??= [];
    warning.acks.push({
      agent: input.agent,
      head: model.heads[input.agent] ?? null,
      note: input.note,
      at: this.ports.clock.iso(),
    });
    await this.persist();
    return { warning };
  }

  /** Attach test provenance to a task (C-1306): {command, exit, head_sha, at}. */
  private async recordTestProvenanceNow(
    taskId: string,
    input: { command: string; exit: number; head_sha: string },
  ): Promise<{ testProvenance: TestProvenance }> {
    const model = await this.load();
    const task = model.tasks[taskId];
    if (!task) {
      throw new Error(`unknown task: ${taskId}`);
    }
    if (typeof input.command !== "string" || input.command.length === 0) {
      throw new Error("test provenance requires a non-empty command");
    }
    if (!Number.isInteger(input.exit)) {
      throw new Error("test provenance requires an integer exit code");
    }
    if (!/^[0-9a-f]{40}$/.test(input.head_sha)) {
      throw new Error("test provenance requires a 40-hex head_sha");
    }
    const git = this.ports.git;
    if (!(await git.hasCommit(task.forkName, input.head_sha))) {
      throw new Error(`commit ${input.head_sha} not found in ${task.forkName}`);
    }
    task.testProvenance = { command: input.command, exit: input.exit, head_sha: input.head_sha, at: this.ports.clock.iso() };
    await this.persist();
    return { testProvenance: task.testProvenance };
  }

  setup(): Promise<SetupResult> {
    return this.serialized(() => this.setupNow());
  }

  createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    return this.serialized(() => this.createTaskNow(input));
  }

  recordPush(input: RecordPushInput): Promise<RecordPushResult> {
    return this.serialized(() => this.recordPushNow(input));
  }

  ackWarning(warningId: string, input: { agent: string; note?: string }): Promise<{ warning: WarningRecord }> {
    return this.serialized(() => this.ackWarningNow(warningId, input));
  }

  recordTestProvenance(
    taskId: string,
    input: { command: string; exit: number; head_sha: string },
  ): Promise<{ testProvenance: TestProvenance }> {
    return this.serialized(() => this.recordTestProvenanceNow(taskId, input));
  }

  /**
   * muse-r46 AUTH: which agent (if any) owns this presented per-task token.
   * Returns null for unknown/garbage tokens, revoked tokens (any non-null
   * revokedAt marker, including the empty string), expired tokens — denied
   * AT the expiry instant, not after it (C-1430) — and tokens whose expiry
   * cannot be parsed (fail closed, C-1422); digests are compared
   * constant-time and the plaintext is never stored. Legacy hash-only state
   * is NOT honored: migrateStoredModel materializes legacy digests as
   * already-expired records with no silent grace (C-1430); a fresh bounded
   * token is obtained only by re-minting through createTask.
   */
  async credentialAgent(presented: string, nowMs: number = Date.now()): Promise<string | null> {
    const model = await this.load();
    const digest = await sha256Hex(presented);
    for (const [agentId, record] of Object.entries(model.agentTokens)) {
      if (timingSafeEqual(digest, record.hash)) {
        if (record.revokedAt != null) {
          return null; // Explicitly revoked (non-null marker, even "")
        }
        const expiryTime = Date.parse(record.expiresAt);
        if (!Number.isFinite(expiryTime) || nowMs >= expiryTime) {
          return null; // Expired (at or past the instant), or expiry unreadable -> deny
        }
        return agentId;
      }
    }
    return null;
  }

  /**
   * Explicitly revoke an agent's write token so subsequent mutating requests are rejected (C-1425).
   */
  async revokeAgentToken(agentId: string, revokedAt: string = this.ports.clock.iso()): Promise<boolean> {
    return this.serialized(async () => {
      const model = await this.load();
      let found = false;
      if (model.agentTokens && model.agentTokens[agentId]) {
        model.agentTokens[agentId].revokedAt = revokedAt;
        found = true;
      }
      if (model.agentTokenHashes && model.agentTokenHashes[agentId]) {
        delete model.agentTokenHashes[agentId];
        found = true;
      }
      if (found) {
        await this.persist();
      }
      return found;
    });
  }

  /** Owning agent of a task, or null for unknown tasks (route: /tasks/:id/tests). */
  async taskOwner(taskId: string): Promise<string | null> {
    const task = (await this.load()).tasks[taskId];
    return task ? task.agentId : null;
  }

  /** Owning agent of a fork (by name or remote), or null (route: /events/push). */
  async forkOwner(fork: string): Promise<string | null> {
    const model = await this.load();
    const record = Object.values(model.agents).find(
      (candidate) => candidate.forkName === fork || candidate.forkRemote === fork,
    );
    return record ? record.agentId : null;
  }

  submitChecks(input: NormalizedChecksPayload): Promise<SubmitChecksResult | StaleChecksResult> {
    return this.serialized(() => this.submitChecksNow(input));
  }

  applyCheckResults(input: {
    policy: string;
    results: NormalizedCheckResult[];
  }): Promise<{ accepted: number; pairs: PairStatusView[]; createdWarnings: WarningRecord[] }> {
    return this.serialized(() => this.applyCheckResultsNow(input));
  }

  private invalidateWarningsFor(model: CoordinatorModel, agent: string, now: string): string[] {
    const invalidated: string[] = [];
    for (const warning of model.warnings) {
      if (warning.status === "active" && warning.pair.includes(agent)) {
        warning.status = "invalidated";
        warning.invalidatedAt = now;
        invalidated.push(warning.id);
      }
    }
    return invalidated;
  }

  /**
   * Trusted-runner submission endpoint (codex C-1309 #7b). The full head
   * vector must match the coordinator's current heads exactly; a stale
   * vector is rejected so results always refer to a well-defined state.
   * Returns `{stale: true}` (the route maps that to 409) instead of
   * throwing, since custom error properties do not survive RPC marshalling.
   */
  private async submitChecksNow(input: NormalizedChecksPayload): Promise<
    | StaleChecksResult
    | SubmitChecksResult
  > {
    const model = await this.load();
    const currentKeys = Object.keys(model.heads).sort();
    const vectorKeys = Object.keys(input.vector ?? {}).sort();
    const stale =
      currentKeys.length !== vectorKeys.length ||
      currentKeys.some((key, index) => key !== vectorKeys[index] || model.heads[key] !== input.vector[key]);
    if (stale) {
      return { stale: true, currentHeads: model.heads };
    }
    const applied = await this.applyCheckResultsNow({ policy: input.policy, results: input.results });
    const model2 = await this.load();
    const runnerReport: RunnerReport = {
      policy: input.policyVerbatim,
      coverage: input.coverageVerbatim ?? [],
      accepted: applied.accepted,
      at: this.ports.clock.iso(),
      vector: { ...input.vector },
    };
    model2.lastRunnerReport = runnerReport;
    await this.persist();
    return {
      stale: false,
      accepted: applied.accepted,
      pairs: applied.pairs,
      createdWarnings: applied.createdWarnings,
      currentHeads: model2.heads,
      runnerReport,
    };
  }

  /**
   * Apply trusted radar/runner results (from POST /checks or direct calls).
   * Each result is stored per pair at its exact pair vector; only
   * `status: "conflict"` creates warnings; a later `clean` result at the same
   * vector resolves an active warning for that pair.
   */
  private async applyCheckResultsNow(input: {
    policy: string;
    results: NormalizedCheckResult[];
  }): Promise<{ accepted: number; pairs: PairStatusView[]; createdWarnings: WarningRecord[] }> {
    const model = await this.load();
    const now = this.ports.clock.iso();
    const createdWarnings: WarningRecord[] = [];
    for (const result of input.results) {
      if (!Array.isArray(result.pair) || result.pair.length !== 2) {
        throw new Error("check result requires pair [a, b]");
      }
      const [a, b] = result.pair;
      if (!(a in model.agents) || !(b in model.agents)) {
        throw new Error(`unknown agent in pair ${a}|${b}`);
      }
      if (!RADAR_STATUSES.includes(result.status as RadarStatus)) {
        throw new Error(`invalid radar status: ${String(result.status)}`);
      }
      if (result.status === "not_checked") {
        throw new Error("runner results must be conflict|clean|unknown, not not_checked");
      }
      // C-1350: per-result heads VALUES (0.1 wire) must agree with the heads
      // the vector declared. Checked here, after submitChecksNow's stale
      // gate, so a stale submission still gets its 409 — parser shape checks
      // stay 400s, value disagreements are 400s only for a CURRENT vector.
      if (result.heads) {
        for (const agent of result.pair) {
          if (result.heads[agent] !== model.heads[agent]) {
            throw new Error(`result heads for ${agent} disagree with the submitted vector`);
          }
        }
      }
      // muse-r46 D1: canonical order before deriving the vector, so a
      // reversed pair overwrites/refreshes the same record instead of
      // duplicating warnings or storing a slot-flipped vector.
      const ordered = canonicalPairHeads(result.pair, { a: model.heads[result.pair[0]], b: model.heads[result.pair[1]] });
      const pair = ordered.pair;
      const vector = ordered.heads;
      const record: PairCheckRecord = {
        key: pairKey(pair),
        pair,
        status: result.status as RadarStatus,
        kind: result.kind,
        evidence: result.evidence,
        evidenceDetail: result.evidenceDetail,
        testsCollected: result.testsCollected,
        vector,
        at: now,
      };
      model.pairChecks[record.key] = record;
      this.pushRadarLog(model, {
        pair,
        heads: vector,
        status: record.status,
        kind: record.kind,
        evidence: record.evidence,
      }, now);
      if (record.status === "conflict") {
        const warning = this.warningForPairAtHeads(model, pair, vector, record, input.policy, now);
        if (warning) {
          createdWarnings.push(warning);
        }
      } else if (record.status === "clean") {
        for (const warning of model.warnings) {
          if (
            warning.status === "active" &&
            pairKey(warning.pair) === record.key &&
            warning.headsAtIssue.a === vector.a &&
            warning.headsAtIssue.b === vector.b
          ) {
            warning.status = "invalidated";
            warning.invalidatedAt = now;
            warning.resolvedBy = `clean check (${input.policy})`;
          }
        }
      }
    }
    await this.persist();
    return { accepted: input.results.length, pairs: this.pairViews(model), createdWarnings };
  }

  private warningForPairAtHeads(
    model: CoordinatorModel,
    pair: [string, string],
    heads: { a: string; b: string },
    record: PairCheckRecord,
    policy: string,
    now: string,
  ): WarningRecord | null {
    // muse-r46 D1: canonicalize the incoming pair/heads so the duplicate
    // lookup and the stored headsAtIssue are slot-order independent, no
    // matter what order the radar/runner reported.
    const ordered = canonicalPairHeads(pair, heads);
    const key = pairKey(ordered.pair);
    const existing = model.warnings.find(
      (warning) =>
        warning.status === "active" &&
        pairKey(warning.pair) === key &&
        warning.headsAtIssue.a === ordered.heads.a &&
        warning.headsAtIssue.b === ordered.heads.b,
    );
    if (existing) {
      return null;
    }
    model.warnSeq += 1;
    const warning: WarningRecord = {
      id: `warn-${model.warnSeq}`,
      pair: ordered.pair,
      headsAtIssue: ordered.heads,
      reason: record.kind ?? "conflict",
      status: "active",
      createdAt: now,
      invalidatedAt: null,
      kind: record.kind,
      evidence: record.evidence ?? `policy ${policy}`,
      acks: [],
    };
    model.warnings.push(warning);
    if (model.warnings.length > WARNINGS_CAP) {
      model.warnings.splice(0, model.warnings.length - WARNINGS_CAP);
    }
    return warning;
  }

  private pushRadarLog(
    model: CoordinatorModel,
    entry: { pair: [string, string]; heads: { a: string; b: string }; status: RadarStatus; kind?: string; evidence?: string },
    now: string,
  ): void {
    model.radarLog.push({ at: now, ...entry });
    if (model.radarLog.length > RADAR_LOG_CAP) {
      model.radarLog.splice(0, model.radarLog.length - RADAR_LOG_CAP);
    }
  }

  private pairViews(model: CoordinatorModel, unprocessedAgents: ReadonlySet<string> = new Set()): PairStatusView[] {
    const ids = Object.keys(model.heads).sort();
    const views: PairStatusView[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const pair: [string, string] = [ids[i], ids[j]];
        const heads: Record<string, string> = { [ids[i]]: model.heads[ids[i]], [ids[j]]: model.heads[ids[j]] };
        const stored = model.pairChecks[pairKey(pair)];
        const fresh =
          stored !== undefined &&
          stored.vector.a === heads[ids[i]] &&
          stored.vector.b === heads[ids[j]];
        // codex C-1357: while an agent has an unprocessed push, its TRUE head
        // is unknown — the Worker never accepted the move. Any stored check
        // (however fresh it looks against the known heads) must NOT present
        // as current: the pair is not_checked with a reason, never clean.
        const uncertain = unprocessedAgents.has(ids[i]) || unprocessedAgents.has(ids[j]);
        views.push({
          pair,
          heads,
          status: uncertain ? "not_checked" : fresh ? stored.status : "not_checked",
          kind: fresh && !uncertain ? stored.kind : undefined,
          evidence: fresh && !uncertain ? (stored.evidenceDetail ?? stored.evidence) : undefined,
          coverage:
            fresh && !uncertain && typeof stored.testsCollected === "number"
              ? { tests_collected: stored.testsCollected }
              : undefined,
          checkedAt: stored ? stored.at : null,
          stale: (stored !== undefined && !fresh) || (fresh && uncertain),
          unprocessedReason: uncertain
            ? "an agent in this pair has an unprocessed push (Worker callback failed after bounded sidecar retries); its true head is unknown"
            : undefined,
          activeWarningIds: model.warnings
            .filter((warning) => warning.status === "active" && pairKey(warning.pair) === pairKey(pair))
            .map((warning) => warning.id),
        });
      }
    }
    return views;
  }

  private runRadar(
    model: CoordinatorModel,
    change: { agent: string; ref: string; sha: string; before: string | null },
  ): { checks: RadarPairResult[]; created: WarningRecord[] } {
    const siblings = Object.keys(model.heads);
    const checks = this.ports.radar.onPush(change, model.heads, siblings);
    const now = this.ports.clock.iso();
    const created: WarningRecord[] = [];
    for (const check of checks) {
      this.pushRadarLog(model, check, now);
      // Warnings exist only for status "conflict" (codex C-1305 #1). The
      // in-Worker StubRadar reports not_checked; conflicts arrive via
      // applyCheckResults from the trusted runner.
      if (check.status === "conflict") {
        // muse-r46 D1: canonical order here too — the StubRadar emits pairs
        // in heads-iteration order, not sorted order.
        const ordered = canonicalPairHeads(check.pair, check.heads);
        const record: PairCheckRecord = {
          key: pairKey(ordered.pair),
          pair: ordered.pair,
          status: check.status,
          kind: check.kind,
          evidence: check.evidence,
          vector: ordered.heads,
          at: now,
        };
        model.pairChecks[record.key] = record;
        const warning = this.warningForPairAtHeads(model, ordered.pair, ordered.heads, record, "radar-inline", now);
        if (warning) {
          created.push(warning);
        }
      }
    }
    return { checks, created };
  }
}
