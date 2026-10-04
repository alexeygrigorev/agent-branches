# TASKS — demo agents

You are working on `demo-target/`, a tiny Cloudflare-Worker-style "shortlinks" service
(zero dependencies, plain ES modules). Run the full suite from `demo-target/` with:

    node --test

Your task is **done** only when the entire suite (existing tests + your new tests) passes.

Work on your own branch cut from the shared base commit. Do not reformat or refactor code
outside what your task needs.

---

## T1 — Link listing & visit counters

Operators currently cannot see which links exist or whether anyone uses them.

Requirements:

- `GET /links` returns `200` with `{"links": [ ...records... ]}` (insertion order is fine).
- Every newly created link record starts with a `visits` counter at `0`.
- Each successful `GET /:slug` redirect increments that link's `visits` by 1.
- `ShortlinkService` grows two public methods: `list()` (all stored records) and
  `recordVisit(slug)`.

Tests to add: listing returns the created links; redirects increment the counter.

## T2 — Object-form create with TTL expiry

`create(slug, url)` positional arguments are getting unwieldy as options grow, and we
want a clean API surface before v1.

Requirements:

- **Breaking change**: `ShortlinkService.create` now takes a single options object:
  `create({ slug, url, ttlSeconds })`. The old positional call form is removed outright,
  not deprecated: do not keep it working via an overload, argument sniffing, or any other
  compatibility shim. Callers must use the object form — update every existing caller
  and test.
- `ttlSeconds` is optional (`null`/omitted = permanent).
- When provided, `ttlSeconds` must be a number of seconds; a non-numeric value is a
  validation error (`POST /links` answers `400`), not silently coerced.
- When provided, the stored record gains `expiresAt` (epoch ms derived from the ttl).
- `resolve()` treats an expired link (`Date.now() > expiresAt`) as not found.
- `POST /links` accepts `"ttlSeconds"` in the JSON body and passes it through.

Tests to add: ttl stored as future `expiresAt`; expired links resolve to 404;
non-numeric `ttlSeconds` rejected; permanent links unaffected.

## T3 — Bulk import endpoint

Migration tooling wants to seed many links from another system in one call.

Requirements:

- `POST /links/bulk` with body `{"links": [{"slug": ..., "url": ...}, ...]}`.
- Creates each link through `ShortlinkService.create`, in order.
- On the first invalid or duplicate item respond `400` with `{"error": ..., "index": <failing index>}`.
- On success respond `201` with `{"created": <count>, "slugs": [<slug>, ...]}` (input order).
- An empty `links` array succeeds with `{"created": 0, "slugs": []}`.
- A body whose `links` is not an array responds `400`.

Tests to add: a multi-link import returns the slugs in order and every imported link
resolves with a 302; empty-list import; malformed body.
