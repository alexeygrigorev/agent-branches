# shortlinks — demo target repo (Agent Branches demo)

A tiny Cloudflare-Worker-style URL shortener. This directory is the **canonical repo**
the demo agents will concurrently work on. Zero npm dependencies: it is plain ES-module
JavaScript tested with the Node built-in test runner.

## Layout

- `src/worker.js` — fetch handler + `route(request, service)`; Worker-style default export
- `src/shortlinks.js` — domain: `ShortlinkService` (`create`, `resolve`), slug/url validation
- `src/store.js` — pluggable KV-ish store (in-memory `MemoryStore` default)
- `test/` — `node:test` suite (`_helpers.js` builds `Request`s and calls `route` directly)
- `wrangler.toml` — Worker packaging metadata (deploying is NOT required for the demo)
- `TASKS.md` — the tasks handed to demo agents
- `.harness/` — demo-harness-only material (`reference-solutions/`: patches, `BASE`,
  notes). Never ship this directory in a tree handed to demo agents — agents get clones
  of the base commit only, and `verify-overlap.sh` fails if a task fork contains it.

## Run tests

    node --test

(no install step; Node >= 18 with global `Request`/`Response` required; developed on Node 24)

## API

- `POST /links` `{"slug":"docs","url":"https://..."}` → `201` record | `400` validation | `409` duplicate
- `GET /:slug` → `302` redirect | `404` unknown
- anything else → `404 {"error":"no route: ..."}`

MIT licensed, part of the parent competition repo.
