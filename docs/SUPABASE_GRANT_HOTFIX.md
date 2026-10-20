# Landing preview grant production repair

Server-only patch on the released v1.2.6 source, isolated from unrelated pending
migrations and client work. Only `drive-transfer` and the two named migrations
are deployed; no desktop or web build is required.

`landing_render_tokens` previously inserted one grant per ready image/segment
on every background status poll. The repair reuses an unconsumed, unrevoked grant
with the exact same team, actor, material, render/segment, key and range budget,
provided more than two minutes remain. The opaque bearer ticket is reconstructed
with domain-separated HMAC-SHA256 from the service key and grant UUID. Only its
SHA256 hash and a non-secret key fingerprint are stored in Postgres. Legacy
random tickets and artifact uploads are unchanged. A key rotation starts a new
reuse pool. Issuance is serialized by artifact authority; consumption retains
its existing row lock, current-permission check and eight-use limit. Reuse never
extends expiry or resets uses. Used/revoked/near-expired grants are not reused.

At one poll per minute for an idle image, this reduces fresh grants roughly
18-fold. Foreground consumption and multiple viewers reduce that benefit;
measure production writes before making stronger claims. This does not remove
client polling or provider reads; the pending web status-only fix can eliminate
background ticket requests in a subsequent web deployment.

Retention deletes at most 500 grants every five minutes, only after expiry plus
one diagnostic day. It never removes active grants, materials, operation records
or Storage objects. The full expiry index replaces the previous partial expiry index instead of
adding duplicate expiry maintenance. Existing backlog drains over days. DELETE does not guarantee
immediate reduction of the allocated database size; vacuum/reuse must be observed
before estimating the Free plan fit.

Migrations:

- `20261202120000_landing_grant_reuse.sql`
- `20261202121000_transfer_grant_retention.sql`

Rollback: redeploy the previous `drive-transfer` source to resume random-ticket
issuance; the additive RPC/nullable column may remain. To stop retention,
unschedule only `soty-transfer-grants-retention`. Do not delete grant rows or drop
columns as a rollback. Deleted expired tickets cannot be restored by rollback;
they had already lost all transfer authority before deletion.
