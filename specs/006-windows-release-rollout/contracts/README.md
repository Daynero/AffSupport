# Contracts: Windows Release Rollout

Three interfaces change or are introduced by this feature. Each file states the shape, the
invariants, who produces and who consumes it, and the failure behaviour.

| Contract | Kind | Status |
| --- | --- | --- |
| [windows-inputs.md](./windows-inputs.md) | Build-time manifest consumed by CI | New |
| [agent-capabilities.md](./agent-capabilities.md) | Runtime contract, agent → web | Existing, extended |
| [release-gates.md](./release-gates.md) | Release manifest + verification rules | Existing, tightened |

Not contracts, and deliberately unchanged: the agent's HTTP route shapes, the SSE stream, the
`stable.json` schema (`schemaVersion` stays `1`), the analytics envelope, and every Supabase
surface. The only reason `stable.json` appears here is a new *rule* about its contents, not a new
field — per Constitution II, extending the release contract without reshaping it.
