/**
 * Compat shim (facade extraction, 2026-10-03): the port types moved to
 * src/ports/. Everything here is a re-export — no behavior change. New code
 * imports from src/ports/ directly.
 */

export type {
  ArtifactsCreateRepoResult,
  ArtifactsPort,
  ArtifactsTokenResult,
  CommitMetadata,
  CreateRepoOptions,
  ForkOptions,
  ForkResult,
  GitAuthor,
  GitHost,
  LogOptions,
  RepoName,
  RepoSummary,
  TokenScope,
  UnprocessedPush,
} from "./ports/githost.js";

export type { ArtifactsPushedEvent } from "./ports/push-events.js";
export { parseArtifactsPushedEvent } from "./ports/push-events.js";
