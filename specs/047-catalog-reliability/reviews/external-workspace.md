# External workspace relocation — 2026-11-06

At the owner's request, development continues from
`/Volumes/LaCie/DevData/Soty/Worktrees/AffSupport-047-beta`.
The previous worktree path is a compatibility symlink. Git HEAD and the complete
tracked/untracked status were preserved. All 53,732 copied entries were checked
by SHA-256, type, symlink target and mode before the internal duplicate was removed.
The worktree contained 410,810,704 regular-file bytes, including dependencies,
uncommitted source, local beta configuration and verification artifacts.

The inactive Hugging Face cache was also copied and verified, with its previous
path retained as a symlink: 771,781,546 regular-file bytes. The external cache root
is private to the owner. Total relocated regular data: 1,182,592,250 bytes.
No cache files with open handles were relocated.

New test commands use the private directory
`/Volumes/LaCie/DevData/Soty/Temp/047` as TMPDIR. The first post-move run passed
50 tests in three suites from the external worktree. The beta VM already stores
its data on LaCie; it was stopped canonically after the completed disposable DB
proof. Its source and temp mounts were verified on restart: the guest reads the exact
host migration bytes, and the default Docker context remains unchanged. A cold
Supabase Storage health timeout is preserved separately; no health gate was bypassed.

Free internal space was about 3.1 GiB before the operation and 5.5 GiB after
relocation and VM shutdown. That difference includes reclaimed runtime resources;
it is not a measurement of moved file bytes. No production action was performed.
