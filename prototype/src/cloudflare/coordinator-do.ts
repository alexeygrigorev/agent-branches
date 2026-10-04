/**
 * Cloudflare Durable Object wrapper (facade extraction, 2026-10-03): thin
 * composition over the provider-neutral CoordinatorCore. Storage goes
 * through DurableObjectCoordinationStore, git through gitHostFromEnv
 * (real Artifacts binding or local sidecar). Every method is a passthrough
 * with the SAME signature as pre-facade, so typed RPC stubs and the wire
 * are unchanged.
 */

import { DurableObject } from "cloudflare:workers";
import type {
  CreateTaskInput,
  CreateTaskResult,
  RecordPushInput,
  RecordPushResult,
  SetupResult,
  StatusResult,
  StaleChecksResult,
  SubmitChecksResult,
  TaskDetail,
} from "../core/coordinator.js";
import { CoordinatorCore } from "../core/coordinator.js";
import type { NormalizedCheckResult, NormalizedChecksPayload } from "../checks-wire.js";
import { cryptoIds, systemClock } from "../ports/clock.js";
import type { PairStatusView, WarningRecord } from "../core/model.js";
import { radarFromEnv } from "../radar.js";
import { DurableObjectCoordinationStore } from "./do-store.js";
import { gitHostFromEnv } from "./githost.js";

export class Coordinator extends DurableObject {
  private readonly core: CoordinatorCore;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.core = new CoordinatorCore({
      store: new DurableObjectCoordinationStore(state),
      git: gitHostFromEnv(env),
      radar: radarFromEnv(env.RADAR_IMPL),
      clock: systemClock,
      ids: cryptoIds,
    });
  }

  setup(): Promise<SetupResult> {
    return this.core.setup();
  }

  createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    return this.core.createTask(input);
  }

  recordPush(input: RecordPushInput): Promise<RecordPushResult> {
    return this.core.recordPush(input);
  }

  status(): Promise<StatusResult> {
    return this.core.status();
  }

  getTask(taskId: string): Promise<TaskDetail> {
    return this.core.getTask(taskId);
  }

  ackWarning(warningId: string, input: { agent: string; note?: string }): Promise<{ warning: WarningRecord }> {
    return this.core.ackWarning(warningId, input);
  }

  recordTestProvenance(
    taskId: string,
    input: { command: string; exit: number; head_sha: string },
  ): Promise<{ testProvenance: TaskDetail["testProvenance"] }> {
    return this.core.recordTestProvenance(taskId, input);
  }

  submitChecks(input: NormalizedChecksPayload): Promise<SubmitChecksResult | StaleChecksResult> {
    return this.core.submitChecks(input);
  }

  applyCheckResults(input: {
    policy: string;
    results: NormalizedCheckResult[];
  }): Promise<{ accepted: number; pairs: PairStatusView[]; createdWarnings: WarningRecord[] }> {
    return this.core.applyCheckResults(input);
  }

  credentialAgent(presented: string, nowMs?: number): Promise<string | null> {
    return this.core.credentialAgent(presented, nowMs);
  }

  revokeAgentToken(agentId: string, revokedAt?: string): Promise<boolean> {
    return this.core.revokeAgentToken(agentId, revokedAt);
  }

  taskOwner(taskId: string): Promise<string | null> {
    return this.core.taskOwner(taskId);
  }

  forkOwner(fork: string): Promise<string | null> {
    return this.core.forkOwner(fork);
  }
}
