# Owner refinement: storage and lossless publication

2026-10-28, revised owner quota 2026-10-28. Extends feature045 after source-beta acceptance. The owner explicitly requests a reasonable per-user allowance, visible use, deleting/replacing images, and optimization before public storage in a Facebook-compatible format without quality loss. This amendment supersedes the original same-source-byte publication and no-decode rules, including the format-specific decode limits: public bytes are now the verified canonical result; original staging remains private and temporary.

## Product contract

- One decimal 0.1 GB (100,000,000 bytes), at most 500 unique retained images, per current workspace owner across their workspaces. Participants share the same library and allowance; uploader identity cannot multiply it. Existing over-limit data remains readable and exact dedup remains possible; new growth is refused atomically.
- The displayed total includes ready, retained inactive, reserved and uncertain publications. Reserved, retained and pending-deletion bytes are explained as subsets, not added twice. Other owned workspaces are represented by aggregate bytes only. Missing/stale reads never become zero.
- Removing a photo from future selection keeps old catalog URLs and occupies storage. The library also exposes inactive photos. Explicit deletion warns that existing catalogs may lose the image. Only confirmed origin deletion and own-CDN purge release capacity; unknown or queued cleanup remains charged. Team deletion and owner transfer cannot erase/bypass accounting.
- Both local and Drive imports use the same server normalizer before the final R2 publication. Local sources first enter private temporary staging. No permanent local media library is created.
- JPEG remains JPEG with its encoded image stream and rendering metadata preserved; removable comments are stripped without requantization. PNG retains pixel/alpha/color precision and rendering metadata, strips non-rendering text metadata, and attempts bounded native deflate recompression. Never use a larger equivalent result. WebP is decoded without resizing and encoded losslessly as PNG, retaining ICC/EXIF rendering information. A compatibility conversion can grow.
- New canonical publications are JPEG/PNG, at most 8,000,000 bytes, and at least 500 pixels in each dimension. JPEG and WebP decode are bounded to 4,000,000 pixels; JPEG's strict validation additionally has a 64 MiB allocation budget. WebP sources (including metadata) are at most 8 MB. PNG source validation remains bounded to 50 MB/16 MP; JPEG sources may contain up to 50 MB before removable comments are discarded. Larger or resource-exhausting sources are explicitly refused, never silently resized. Ordinary JPEG encoding or PNG/WebP-to-JPEG is not called lossless.
- Original source size/hash, canonical size/hash/MIME and optimizer version are distinct. Canonical identity drives dedup and exact readback. Frozen unknown output is reconciled without a second normalization. Existing published URLs are not rewritten.
- Short notice explains JPEG/PNG optimization when possible and lossless WebP-to-PNG conversion. Accepted format is not a guarantee of external content approval or Meta ingestion. Actual importer acceptance remains T055.

## Implementation and diagnostics

1. Add pinned/self-contained WebP decoder with upstream license/provenance. Implement deterministic bounded normalization; verify dimensions, input/output byte identities, raster equivalence and rendering metadata with an independent decoder.
2. Add forward-only1570 storage ledger/account serialization, source/canonical reservation metadata, storage/library reads and tests. Applied migrations through1560 remain unchanged.
3. Add typed API/guards, usage states and existing control/confirmation components. Reuse current Realtime invalidation and explicit refresh; no recurring client polling.
4. Record correlated optimization start/completion/failure and current authoritative storage projection in the read-only diagnostic CLI, with missing evidence explicit. Per-owner changes fan out content-free revisions to each owned workspace through the existing Realtime channel, including ready/retained/pending categories and unknown cleanup outcomes. Do not collect names, URLs, paths, pixels, credentials or hashes in analytics.
5. Run targeted codec/worker/quota/UI/diagnostic tests, independent reviews and required verification. Apply only reviewed pending migrations to the owned local beta after the disposable full-chain DB gate; preserve its connected profile. Verify actual imports, accounting, cleanup and existing catalogs in Chrome.

## Acceptance

- Concurrent imports in different workspaces cannot overspend one owner's last bytes. Exact reuse charges once. Owner transfer, team deletion, ready orphan tombstones, failed/unknown cleanup and stale fences retain correct accounting.
- Source and canonical identities differ safely; local and Drive produce the same deterministic canonical image. Invalid/too-small/too-large outputs never become public. Retry and lost-response reconciliation retain canonical bytes.
- Independent raster comparisons prove no changed pixels/alpha or dimensions for supported cases; rendering metadata stays intact. JPEG scan bytes remain identical. Incompressible JPEG/PNG are kept without growth.
- PNG validation checks palette presence/order/shape, unfilters bounded indexed rows (including packed depths, every filter and Adam7) and rejects out-of-range palette indices. JPEG is strictly decoded for validation without re-encoding; malformed tables/scans and resource exhaustion are failures. No parser is described as universal external-importer acceptance.
- UI reports accurate usage, uncertain processing/cleanup and stale-read state, permits deletion of inactive photos, and shows capacity after confirmed cleanup before another upload.
- Native Edge boot and resource measurements establish the normalizer's actual limits. Hosted aggregate-isolate and real Meta ingestion remain separate measured acceptance gates.

## Owner quota revision

The owner set 500 images at approximately 200 KB each: 500 × 200,000 = 100,000,000 bytes, or 0.1 decimal GB per owner. Fifty owners at their full allowance consume up to 5 GB of accounted public image objects. Actual file sizes vary: either the 500-image or 100 MB bound can be reached first. Temporary staging and provider overhead are separate from this allowance. Existing over-limit data is retained and exact reuse remains allowed. Migration1590 applies this revised bound without editing already-applied1570/1580.

Two independent source reviews of the lock-order revision (SHA-256
`35a1fea1554e3f7d84ac9fce81d9bb9ef091abae40ebbace5551f72c40ea8654`)
scored 98/100 after fixing a team-deletion lock-order inversion. The review
scores do not establish native execution, beta acceptance or release readiness. The later explicit transaction wrapper is separately pending verification.
