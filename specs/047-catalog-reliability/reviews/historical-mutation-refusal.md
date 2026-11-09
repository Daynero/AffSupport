# Historical mutation receipt — working increment

The preflight helper used by trash/restore returned a replay marker for any
reused succeeded operation. Its route then returned operationId/state/reused
without the materialId required by the shared result parser. The parser rejected
that malformed response. Adding the requested material ID alone would be unsafe:
a later restore, move or edit may already have changed the material.

A lightweight probe against the real helper reproduced the missing refusal.
The helper now returns the existing typed PROCESS_RESULT_UNCERTAIN error for a
historical terminal before metadata preflight or another provider action. It
neither marks that original operation failed nor fabricates a current file result.
The route no longer emits the incomplete replay response on this path. Other
operationRecord callers retain their separate unfinished work; this increment
does not claim to repair all historical file operations.

The causal probe passes with zero provider reads and zero failure-sink calls.
The SQL-backed preflight regression passes within the143-test/six-file follow-up
run. Complete static/source checks remain pending. This
increment is not applied to beta yet. Complete current-generation readback,
partial companion recovery and manual acceptance remain open under T023.

The old running beta now also reproduces the malformed reply using the exact
known completed synthetic trash key after its confirmed restore. The endpoint
returns200/ok while the shared file parser rejects its missing material field.
Full-row digests of that material, operation and group intent are unchanged, and
the fixture stays active. No replacement key or unknown operation was used. See
historical-mutation-beta-reproduction.json. A matching after-fix beta check remains
pending deployment of the verified candidate.
