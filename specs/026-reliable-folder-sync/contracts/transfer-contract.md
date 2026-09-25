# Contract: Universal file/folder transfer

## Local manifest and operation

Enumeration precedes remote mutation. Every directory is an entry, including
empty directories. Preserve names; normalize Unicode only for comparison.
Relative paths reject absolute paths, empty segments, dot, dot-dot and NUL.
Counts/depth/length/size use shared bounds.

```ts
type LocalOperationState =
  | 'preparing'
  | 'running'
  | 'partial'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'interrupted_input_required';
type LocalItemState =
  'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'canceled' | 'input_required';
type LocalOperationStage =
  'preparing' | 'creating_folders' | 'transferring' | 'moving' | 'updating_catalog' | 'done';
type LocalManifestEntry =
  | { kind: 'directory'; clientItemKey: string; relativePath: string; parentKey: string | null }
  | {
      kind: 'file';
      clientItemKey: string;
      relativePath: string;
      parentKey: string | null;
      sizeBytes: number;
      mimeType: string;
      source: File;
    };
```

File/handles are ephemeral. Server serializers never receive the local group,
File, handle or absolute local path. Individual remote actions use existing
authorized and idempotent material operations.

## Inputs and scheduling

- Mixed drop, file input and directory handles yield equivalent manifests.
  Exhaust every directory-reader batch; cycles/repeated handles and unreadable
  branches produce explicit relative-path issues.
- One Add files action offers Files/Folder. showDirectoryPicker is primary.
  Fallback: capability-gated native picker, opaque scoped grant, bounded
  enumeration and authorized source read. webkitdirectory loses empty folders.
- Unsupported input is shown before writes; chooser cancel makes no mutation.
- Freeze destination before enumeration. Create directories topologically,
  reuse resolved parents; failed parents block children with an explicit reason.
- At most three concurrent items per group and six per provider.
- Conflicts require skip, keep_both or explicitly permitted replace; no implicit
  directory merge. Clipboard, tree drop and context-menu moves share the
  coordinator. Server authorization, ancestry and cycle checks stay authoritative.

## Progress and recovery

Only local callbacks and existing responses update progress. Stage/denominator
are explicit; confirmed byte offsets never count twice within an attempt.
No percentage RPC, cloud write, subscription or telemetry is added. Catalog
postcondition precedes success; skipped/canceled/partial results are distinct.

IndexedDB stores actor/team-scoped metadata on acceptance/item transitions:
relative paths, destination, state, attempt, operation/idempotency IDs and
confirmed results. Never bytes, secrets, signed URLs, handles or byte progress.
Retention: seven days terminal, thirty interrupted. Quota failure shows
session-only recovery; sign-out purges actor history.

Reconcile saved operation IDs before retry, including lost-finalize responses.
Never repeat succeeded items. Unfinalized uploads require reselection, explicit
confirmation and a new attempt from byte zero; matching path/size does not
resume an earlier byte session. Local ownership leases prevent duplicate tab
execution without server heartbeat. Cancel stops scheduling and aborts active
requests; confirmed remote results remain. Dismissal does not cancel.
The workspace provider survives folder navigation.

## Acceptance

Picker/drop parity: 1,000 files, 100 directories, ten empty directories, depth
ten, mixed roots, Unicode, zero-byte files on macOS and Windows. Twenty partial
scenarios yield no false success. Progress on/off has identical cloud I/O.
