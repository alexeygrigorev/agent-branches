export type HeadVector = Record<string, string>;

export interface HeadChange {
  agent: string;
  ref: string;
  sha: string;
  before: string | null;
}

/**
 * Radar result status for one agent pair at specific heads (codex C-1305 #1).
 *
 * - `conflict`: the check ran at exactly these heads and found a real
 *   conflict. This is the ONLY status that produces a warning.
 * - `clean`: the check ran at exactly these heads and found no conflict.
 * - `unknown`: the check ran but was inconclusive (error, timeout,
 *   unsupported merge). Never treated as clean or as a conflict.
 * - `not_checked`: no check has produced a result for this pair at the
 *   current heads. The in-Worker StubRadar always reports this; real
 *   check results come from the trusted local runner (C-1309).
 */
export type RadarStatus = "conflict" | "clean" | "unknown" | "not_checked";

export const RADAR_STATUSES: readonly RadarStatus[] = [
  "conflict",
  "clean",
  "unknown",
  "not_checked",
];

export interface RadarPairResult {
  pair: [string, string];
  heads: { a: string; b: string };
  status: RadarStatus;
  /** Conflict classifier, e.g. "merge-conflict". Present mainly for conflicts. */
  kind?: string;
  /** How the status was determined (command, exit code, output excerpt). */
  evidence?: string;
}

export interface Radar {
  onPush(change: HeadChange, heads: HeadVector, siblings: string[]): RadarPairResult[];
}

/** Canonical pair key: unordered pair encoded deterministically. */
export function pairKey(pair: readonly [string, string]): string {
  const [a, b] = pair[0] <= pair[1] ? pair : [pair[1], pair[0]];
  return `${a}|${b}`;
}

/**
 * Stub radar: records that each sibling pair WOULD be checked at the current
 * heads, but never claims a check happened. Always `not_checked` — differing
 * heads alone are never an active warning (codex C-1305 #1).
 */
export class StubRadar implements Radar {
  onPush(change: HeadChange, heads: HeadVector, siblings: string[]): RadarPairResult[] {
    const results: RadarPairResult[] = [];
    for (const sibling of siblings) {
      if (sibling === change.agent) {
        continue;
      }
      results.push({
        pair: [change.agent, sibling],
        heads: { a: heads[change.agent], b: heads[sibling] },
        status: "not_checked",
      });
    }
    return results;
  }
}

export class SilentRadar implements Radar {
  onPush(_change: HeadChange, _heads: HeadVector, _siblings: string[]): RadarPairResult[] {
    return [];
  }
}

export function radarFromEnv(value: string | undefined): Radar {
  return value === "silent" ? new SilentRadar() : new StubRadar();
}
