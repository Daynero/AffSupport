# Contract — Local App HTTP Surface

**Serves**: FR-002, FR-005, FR-009b, FR-023 … FR-027, FR-037.
**Status**: additive. No existing route is removed in this release.

The local app already has a stated convention (Principle V): every feature exposes `registerXRoutes(app, deps)`, success returns the tool's state snapshot, errors return `reply.code(N).send({ error })` where `error` is a **stable machine code**, never a sentence. Everything below extends that convention.

---

## 1. Request admission

One `onRequest` hook, **registered first, applying to every request with no path exemption**, in this order. The early phase matters: it runs before body parsing, so a rejected request never causes a byte of an upload to be read.

| Step | Rule | Failure |
|---|---|---|
| 1. Host | `Host`, port stripped, must be exactly `127.0.0.1`, `localhost` or `[::1]`. The port, if present, must equal the listening port. Missing → reject (HTTP/1.1 requires it). A comma in the value → reject (duplicate headers). | `403 HOST_NOT_ALLOWED` |
| 2. Origin | Must be in the allowlist when present. Extended beyond `/api/*` to `/pair` and `/local`. A missing origin stays permitted for `/health` and for native callers. | `403 ORIGIN_NOT_ALLOWED` |
| 2a. Pair navigation | For `/pair`, a missing origin is accepted **only** for a top-level navigation, discriminated by `Sec-Fetch-Mode: navigate` + `Sec-Fetch-Dest: document`. | `403 ORIGIN_NOT_ALLOWED` |
| 2b. Native discriminator | `/native/*` is rejected whenever **any** fetch-metadata header is present. Browsers always send them; native clients never do. | `403 ORIGIN_NOT_ALLOWED` |
| 3. Token | Constant-time comparison. A non-string value (a repeated query parameter yields an array) is rejected before comparison. | `401 INVALID_SESSION_TOKEN` |
| 4. Failure counter | 20 failed token checks in a minute → 60 s cooldown on all `/api/*`, reset on success, logged. | `429 AUTH_COOLDOWN` |

**Why step 1 matters most**: the pairing endpoint hands out the session token to anyone who follows its redirect. A rebound origin that does so is fully paired. Host validation is what closes that.

---

## 2. `GET /api/stream` (new)

Replaces seven separate live-update endpoints with one multiplexed stream.

**Request**

```
GET /api/stream?channels=compressor,transcription,power
x-session-token: <token>          ← a header, never a query parameter
```

**Response**: `text/event-stream`, no buffering, no compression. Each frame:

```json
{ "channel": "compressor", "event": { … the existing per-channel payload, unchanged … } }
```

| Rule | |
|---|---|
| Snapshot on subscribe | Each requested channel replays its current snapshot immediately, as today. |
| Payloads unchanged | Only the envelope is new. Existing per-channel event types are untouched. |
| Heartbeat | A comment frame every 15 s. |
| Stalled writer | A client whose write buffer grows without draining is dropped. Today an unbounded buffer accumulates per event inside the queue's drain loop — a live memory leak. |
| Cap | 8 subscribers per channel, 32 per process. On exceeding, **evict the oldest** after sending a terminal `replaced` frame, so it reconnects rather than hangs. Refusing the newest would make the app look broken to the person who just opened a tab. |
| Sampling | A channel that costs something to produce (consumption sampling) starts only when subscribed and stops when the last subscriber leaves. |
| Cross-origin headers | The streaming branch bypasses the normal send hook and **must set its own**. |

**Capability gate**: advertised as `event-stream` in the health capability list. A client that does not see it falls back to the seven existing endpoints. Those endpoints are **not removed** in this release.

**Authentication contract that any transport must satisfy** (stated so it survives a change of mechanism): the token travels as a request header, or as a single-use ≤30 s stream-scoped ticket that is not the session token; reconnection re-authenticates rather than replaying a long-lived URL; and the resulting URL is safe to appear in a log or a referrer.

---

## 3. Subresource capability tickets

Applies to routes fetched by an image, video or media element, where a header is impossible and blob conversion would break range requests.

```
GET /api/images/:id/content?t=<ticket>
```

The ticket is issued in the authenticated response that describes the resource. Bound to one method and one path, 5-minute TTL, derived from the session secret but **not equal to the session token**. Range requests continue to work.

`401 TICKET_INVALID` on a bad or expired ticket.

---

## 4. Path grants

**New:** `POST /api/files/add`, `POST /api/transcription/files/add` and `POST /api/landing-preview/open` accept grant identifiers rather than absolute paths.

```json
{ "grants": ["g_..."] }          // was: { "paths": ["/Users/…/clip.mp4"] }
```

Grant identifiers are minted by the local app at user-driven selection points and returned by the picker and drop-resolution responses. The interface can only echo one back; it cannot name a location.

During migration a raw path is still accepted if it resolves to an existing grant, or to a descendant of a directory grant.

**Refusal**: `403 PATH_NOT_GRANTED` — **the same code for every cause** (not granted, expired, inode changed, out of bounds). Distinguishing them would turn the route into an existence oracle for arbitrary paths.

The refusal is decided **in memory first**; the filesystem is touched only for paths that already matched a grant, so timing does not leak existence. Logs carry a hash of the path, never the path.

---

## 5. Stop, everywhere

Every tool module implements `cancel(id)` and `cancelAll()`, and every one exposes both over **browser-session** routes.

| Tool | Today | Added |
|---|---|---|
| compressor | per-job cancel + cancel-all | — |
| transcription | cancel-all | per-job cancel |
| landing optimizer | cancel-all | per-job cancel |
| landing preview | cancel | — |
| **media actions** | **nothing** | `POST /api/media-actions/:id/cancel`, `POST /api/media-actions/cancel-all` |

Media actions keep their existing native enqueue route; the new cancel routes are session-authenticated. Media-action state rides the compressor's existing stream as an added optional field rather than opening an eighth channel — FR-009b and SC-020 bound how many live connections the interface may hold.

---

## 6. Transitions

A refused transition returns `409 { "error": "TRANSITION_NOT_ALLOWED" }` and **leaves state unchanged** (FR-001).

Rollout is permissive first: the transition function records the edge without blocking, so a full suite run surfaces every edge the running code actually takes — those are table bugs, not code bugs. Only then does it become strict.

---

## 7. Size and rate limits

**The multipart default is inverted**: from effectively unbounded to 32 MiB globally, so a route that forgets to specify is safe rather than open. Routes opt in.

| Route | File size | Notes |
|---|---|---|
| `/api/files/upload` | 20 GiB | A video compressor genuinely handles this. Bounded, not unbounded. |
| `/api/transcription/files/upload` | 20 GiB | |
| `/api/landing/upload/zip` | 512 MiB | |
| `/api/landing/upload/folder/file` | 32 MiB | Per file. |
| `/api/images/:slot` | existing image cap | Already correct; the template for the rest. |

**Folder-upload session budget** — per-file limits do nothing against a hundred thousand files:

| Limit | Value |
|---|---|
| Files | 5 000 |
| Total bytes | 2 GiB |
| Wall clock | 10 min |
| Path depth | 16 segments, 255 chars each |

Exceeding any of these returns `413 UPLOAD_BUDGET_EXCEEDED` and **tears the session down** — temp directory removed — rather than leaving it half-written. The session carries an identifier the client must echo, so two tabs cannot interleave into one directory.

**Rate limits** — scoped, never global (a global limit would throttle legitimate reconnect storms and the upload loop). The key is a constant, because every request is loopback and a per-address limiter here is theatre.

| Route | Budget |
|---|---|
| `/api/entitlement` | 10/min — a signature-verify oracle |
| `/pair`, `/local` | 5/min — they hand out the token |
| routes that spawn a system search | 10/min — a resource control, not a security one |

The real anti-brute-force control is the auth-failure counter in §1, because it keys on *failure* rather than request count. Stated honestly: a 64-hex token at 20 guesses a minute is unbreakable by many orders of magnitude, so this exists to make the attempt **visible**, not the search infeasible.

---

## 8. Errors and logs

Every route maps failures to a fixed code list, defaulting to `INTERNAL`. **No route relays an underlying message**, which routinely carries an absolute path (FR-029a). The team bridge already does this correctly and is the pattern to copy.

Logging emits the **route pattern**, not the raw URL — one change removes the query string and every path-shaped identifier at once, and patterns are more useful for diagnostics anyway. Token headers and the **redirect location header** are redacted; a formatter scrubs any remaining 64-hex string. The local app's own output goes to an owner-only rotating file rather than system-wide logging.

---

## 9. State snapshots

`QueueState`, `TranscriptionState` and `LandingState` gain a monotonic `revision`. Every mutation broadcasts synchronously, so an HTTP response carries exactly the revision just broadcast, and a slow response that arrives after a newer snapshot is discarded by the client. An older local app omits the field and the client normalises it to `0`, degrading to today's behaviour.
