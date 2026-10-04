/**
 * Coordinator state model (facade extraction, 2026-10-03): pure data plus
 * load-time migration, no Cloudflare imports. The DO persists this object
 * under one store key; its shape is internal (the wire is CONTRACT.md).
 */

import type { ChecksCoverageCounts, ChecksPolicySpec, EvidenceBag } from "../checks-wire.js";
import type { RadarStatus } from "../radar.js";
import type { UnprocessedPush } from "../ports/githost.js";

export interface AgentRecord {
  agentId: string;
  taskId: string;
  forkName: string;
  forkRemote: string;
  ref: string;
  head: string | null;
  pushes: number;
  createdAt: string;
  lastPushAt: string | null;
}

export interface TaskRecord {
  taskId: string;
  agentId: string;
  forkName: string;
  forkRemote: string;
  ref: string;
  createdAt: string;
  /** Canonical commit this task's fork was created from (codex C-1306). */
  baseSha: string;
  /** Free-form intent text supplied at task creation (codex C-1306). */
  intent: string | null;
  /** Last posted test provenance (codex C-1306); agents POST /tasks/:id/tests. */
  testProvenance: TestProvenance | null;
}

export interface TestProvenance {
  command: string;
  exit: number;
  head_sha: string;
  at: string;
}

export interface WarningAck {
  agent: string;
  /** Head of the acknowledging agent's fork at ack time (codex C-1306). */
  head: string | null;
  note?: string;
  at: string;
}

export interface WarningRecord {
  id: string;
  pair: [string, string];
  headsAtIssue: { a: string; b: string };
  reason: string;
  status: "active" | "invalidated";
  createdAt: string;
  invalidatedAt: string | null;
  /** Conflict classifier from the radar/runner result, when provided. */
  kind?: string;
  /** How the conflict was detected. */
  evidence?: string;
  /** Set when a later clean check at the same heads resolved the warning. */
  resolvedBy?: string;
  /** Acknowledgements recorded via POST /warnings/:id/ack. */
  acks: WarningAck[];
}

export interface RadarLogEntry {
  at: string;
  pair: [string, string];
  heads: { a: string; b: string };
  status: RadarStatus;
  kind?: string;
  evidence?: string;
}

/** Last accepted radar/runner result for a pair, at an exact pair vector. */
export interface PairCheckRecord {
  key: string;
  pair: [string, string];
  status: RadarStatus;
  kind?: string;
  /** Summary string (0.0 evidence, or 0.1 evidence.summary chain). */
  evidence?: string;
  /** C-1350: verbatim typed evidence object served on the pair view (0.1). */
  evidenceDetail?: EvidenceBag;
  /** C-1350: combined tests the runner collected for this pair, when reported. */
  testsCollected?: number;
  vector: { a: string; b: string };
  at: string;
}

/** Derived per-pair view for /status: fresh results only; stale => not_checked. */
export interface PairStatusView {
  pair: [string, string];
  /** C-1350: heads keyed by agentId (was positional {a, b}). */
  heads: Record<string, string>;
  status: RadarStatus;
  kind?: string;
  /** C-1350: string (0.0) or verbatim typed evidence object (0.1). Must stay
   * EvidenceBag, not Record<string, unknown>: an unknown-valued index
   * signature collapses the typed-RPC stub method to `never`. */
  evidence?: string | EvidenceBag;
  /** C-1350: per-pair coverage of the FRESH check (L4 gate: clean counts only
   * with tests_collected > 0 at current heads); omitted when stale. */
  coverage?: { tests_collected: number };
  checkedAt: string | null;
  /** True when a stored check exists but no longer matches the current heads. */
  stale: boolean;
  /** codex C-1357: set while a member agent has an unprocessed push — the
   * pair's true head state is unknown, so nothing presents as current. */
  unprocessedReason?: string;
  activeWarningIds: string[];
}

export interface RunnerReport {
  /** Verbatim: the 0.0 policy string or the 0.1 policy object (C-1350). */
  policy: string | ChecksPolicySpec;
  /** Verbatim: the 0.0 string[] or the 0.1 counts object (C-1350). */
  coverage: string[] | ChecksCoverageCounts;
  accepted: number;
  at: string;
  vector: Record<string, string>;
}

export interface CoordinatorModel {
  canonicalName: string | null;
  canonicalRemote: string | null;
  seq: number;
  warnSeq: number;
  agents: Record<string, AgentRecord>;
  tasks: Record<string, TaskRecord>;
  heads: Record<string, string>;
  /**
   * muse-r46 D2: bounded push-dedup memory — per agent, the latest
   * SEEN_PUSHES_CAP_PER_AGENT accepted "sha" values. The current head is
   * always deduped via the heads check; older ring entries catch out-of-
   * order webhook redelivery within a bounded window.
   */
  seenPushes: Record<string, string[]>;
  /**
   * muse-r46 AUTH: SHA-256 digest of each agent's per-task write token
   * (minted at task creation). The plaintext is returned once to the caller
   * and never persisted or logged.
   */
  agentTokenHashes: Record<string, string>;
  /**
   * Structured token records with cryptographic digest, expiry ISO timestamp,
   * and optional revocation timestamp (C-1425).
   */
  agentTokens: Record<string, AgentTokenRecord>;
  warnings: WarningRecord[];
  radarLog: RadarLogEntry[];
  pairChecks: Record<string, PairCheckRecord>;
  lastRunnerReport: RunnerReport | null;
}

export interface AgentTokenRecord {
  hash: string;
  expiresAt: string;
  revokedAt: string | null;
}

export const CANONICAL_BASE = "agent-branches-canonical";
export const RADAR_LOG_CAP = 50;
export const WARNINGS_CAP = 200;

/** muse-r46 D2: per-agent bound on the push-dedup ring (latest N accepted pushes). */
export const SEEN_PUSHES_CAP_PER_AGENT = 16;

export function emptyModel(): CoordinatorModel {
  return {
    canonicalName: null,
    canonicalRemote: null,
    seq: 0,
    warnSeq: 0,
    agents: {},
    tasks: {},
    heads: {},
    seenPushes: {},
    agentTokenHashes: {},
    agentTokens: {},
    warnings: [],
    radarLog: [],
    pairChecks: {},
    lastRunnerReport: null,
  };
}

/**
 * Migration for models persisted before a field existed. Pure: returns the
 * input (mutated in place, as pre-facade load() did) or a fresh model.
 */
export function migrateStoredModel(stored: CoordinatorModel | undefined): CoordinatorModel {
  const model = stored ?? emptyModel();
  model.pairChecks ??= {};
  model.warnSeq ??= model.warnings.length;
  model.lastRunnerReport ??= null;
  // muse-r46 D2: pre-0.1.1 models kept one flat "agentId:sha" array;
  // regroup it into the bounded per-agent ring.
  if (Array.isArray(model.seenPushes)) {
    const legacy = model.seenPushes as unknown as string[];
    const perAgent: Record<string, string[]> = {};
    for (const key of legacy) {
      const sep = key.indexOf(":");
      const agent = sep === -1 ? key : key.slice(0, sep);
      (perAgent[agent] ??= []).push(key);
    }
    for (const agent of Object.keys(perAgent)) {
      perAgent[agent] = perAgent[agent].slice(-SEEN_PUSHES_CAP_PER_AGENT);
    }
    model.seenPushes = perAgent;
  }
  // muse-r46 AUTH: agents created before 0.1.1 have no stored digest.
  model.agentTokenHashes ??= {};
  model.agentTokens ??= {};
  for (const [agentId, hash] of Object.entries(model.agentTokenHashes)) {
    if (!model.agentTokens[agentId]) {
      model.agentTokens[agentId] = {
        hash,
        // C-1430: legacy credentials have an unknown mint time and get NO
        // silent grace. They materialize as already-expired records —
        // deterministic and idempotent across reloads (no wall clock here,
        // so a restart can never extend the record) — and write access is
        // restored only by an explicit re-mint through createTask.
        expiresAt: new Date(0).toISOString(),
        revokedAt: null,
      };
    }
  }
  return model;
}

export type { UnprocessedPush };
