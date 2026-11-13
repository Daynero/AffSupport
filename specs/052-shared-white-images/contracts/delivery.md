# Contract: direct global-image URLs

## URL and identity

Public pattern: `https://<environment-media-origin>/g/<versioned-opaque-token>.jpg` or `.png`, consistent with actual bytes. Token contains only global asset UUID, generation, MIME discriminator, environment and key version with HMAC-SHA256 authentication. No team/catalog/user ID or source filename. It has no expiry, login requirement or redirect. It is a permanent public alias, not a short-lived provider upload/download grant; the runtime signing key never appears in it.

Only trusted alias preparation signs tokens. Browser/allocator receives stored verified URLs; no per-row token signing in create. The byte object key is fixed `g1/<asset_uuid>`, create-only immutable output from045 validation. Worker route only `/g/*`; canonical `/g1/*` remains direct R2 custom-domain path, so canonical fetch does not recursively invoke Worker.

## Read-only Worker

GET/HEAD only; all other methods405. Validate bounded URL length, exact path/token grammar, HMAC via Web Crypto verify, allowed key version/environment, UUID/generation/MIME. Reject malformed/unknown authentication404 without leaking any private lookup. No arbitrary URL fetch, path traversal, customer redirect, cookies, UA-dependent content or DB calls. Canonical target constructed only from trusted origin+validated asset UUID; no user-supplied headers/query forwarded.

GET streams one canonical response. Return correct image/jpeg or image/png, nosniff, public immutable positive caching, valid ETag/content length as provided; no transformations. HEAD preserves metadata without inventing proof of byte equality. Missing object404 or backend failure has explicit status and no positive/long negative caching. All aliases for one asset have identical bytes/MIME. A probe compares positive canonical and alias bytes before admission.

## Cache and budgets

Worker fetches the same canonical object URL for all generations, using ordinary canonical-URL cache behavior. Enterprise `cf.cacheKey` is not a prerequisite. Do not assume a cache HIT from headers/config alone: isolated provider evidence must show HIT/MISS/origin reads and real route behavior without recursive Worker calls.

No tenant-specific cached body/header. Do not cache failure as ready. Cache invalidation for legacy cleanup stays on original legacy canonical URLs; `/g1/` and `/g/` are outside its target scope. Global published URLs are not auto-cleaned by the30-day policy. Keeping the asset content proof and compatible serving-health fresh affects new allocation eligibility, not existing public reads.

Serving health probes every≤60s, fresh≤120s; report observations as point-in-time evidence, not global uptime. Per-request delivery log excludes full URLs/tokens/raw headers/IP/content; bounded normalized method/status/stage/latency may be aggregated, not a200-use counter.

## Runtime secrets and environment binding

Separate beta/dev/production media origins/buckets/HMAC keys/key versions and exact target-confirmation digest. Importing a production token in beta is rejected. Provision keys only through existing ignored secrets workflows; never analytics connection or browser env. Retain old verify keys for all issued URLs; any key-change plan that would break existing reads is rejected before activation. Do not introduce unbounded key trial: key version chooses one configured verifier, unknown version404.

Delivery workspace uses current TypeScript/Vite build toolchain and no runtime npm dependency. Exact compiled Worker bytes, route selector `/g/*`, canonical origin, accepted key versions (no values), CSP compatibility and probe proof are archived in release evidence. Publishing this Worker is an explicit normal-release/provider action; no direct wrangler deploy or publishing during planning.

## Acceptance

Different generation tokens → direct200 identical bytes; same pair replay → same URL. Tampered token, wrong environment/MIME/key version, path traversal, foreign upstream and non-GET methods are refused. Verify first/next ready series, restart, old key retention, cache HIT/MISS, HEAD/GET, browser/anonymous access, no full URL telemetry. Actual Meta import is separate: positive GET alone never proves acceptance or any change in advertising restrictions.

## Old alias readiness

Identity proof has no daily per-alias TTL. Existing closed-generation aliases inherit fresh asset content proof24h plus serving-health120s covering accepted route/protocol/key versions. New config/key revision requires positive compatibility probes with old tokens. Current+2 preparation does not require refreshing every historical alias; old-pair replay after24h/rotation keeps its URL with no per-row GET.
