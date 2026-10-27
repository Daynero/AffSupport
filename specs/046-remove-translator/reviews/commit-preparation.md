# Commit preparation — feature046

The commit isolates translator retirement from the pre-existing044/045 working
changes, using the captured initial baseline. Unrelated source changes remain in
the owner's working tree. The feature pointer and046 design/evidence are included.

Generated DB types retain only the canonical new retirement-view definition for
this commit. Incidental generator-wide argument/nullability changes were removed;
pre-existing assignment RPC types remain outside the commit. No private schema,
production version, stable manifest or release tag was changed.

Isolated HEAD+046 validation: static gates passed after connecting the existing
workspace-local Vite dependencies (the initial project check reported a missing
plugin in the fixture). Project typecheck then passed;146 scoped tests passed,
including a rerun after removing an empty directory left by fixture preparation.
The web production build passed. The existing Launch graph budget still fails:
44695 bytes >40000. This is not a green full release or packaged beta/Windows proof.
