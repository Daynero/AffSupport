import type { LucideIcon } from 'lucide-react';
import {
  ArrowDownToLine,
  ClipboardList,
  ClipboardPaste,
  Copy,
  Eye,
  FileText,
  FolderOpen,
  GitBranch,
  Link2,
  ListPlus,
  Minimize2,
  PencilLine,
  Scissors,
  Share2,
  Sparkles,
  SquarePen,
  Tags,
  Trash2,
  Undo2,
  Upload
} from 'lucide-react';
import type { MaterialKind, TeamPermissionFlag, TeamPermissions } from '@video-compressor/shared';
import type { TranslationKey } from '../../i18n';

/**
 * What can be done to a material — said once, for every surface that shows one.
 *
 * Before this, each surface carried its own answer. A video in a folder offered
 * eleven things; the same video in a search result offered five and a different
 * five; the same video attached to a task offered six unlabelled icons and could
 * not be catalogued, transcribed, compressed, renamed, moved or tagged at all.
 * The owner's own example is the shape of it: making a catalog out of a video
 * attached to a task meant closing the task, finding the file in the explorer,
 * doing it there, and coming back — losing the task's unsaved edits on the way.
 *
 * None of that was a decision. It is what happens when the answer to "what can I
 * do with this?" is written once per screen.
 *
 * ## The three states, and why there are three
 *
 * `applies` asks whether the object can *ever* take this action. A folder can
 * never have a product catalog, so the item is **absent** — not greyed out.
 * `available` asks whether it can take it *now*. A video whose Drive is
 * disconnected can be catalogued tomorrow, so the item is **present with one
 * line saying why not today**.
 *
 * The product had only two states, and used the wrong one for both: a dimmed
 * control that explains nothing, wherever either was meant.
 */

/** Every action, named once. The union is closed so a surface cannot invent one. */
export const MATERIAL_ACTION_IDS = [
  // open
  'open',
  'detail',
  'showInFolder',
  'provenance',
  // get
  'copyLink',
  'share',
  'download',
  'downloadRestitched',
  'copyText',
  // make
  'productCatalog',
  'transcribe',
  'compress',
  'process',
  'processInside',
  'regeneratePreview',
  'editText',
  'createTask',
  'addToTask',
  // organise
  'rename',
  'move',
  'colourTag',
  'editMetadata',
  'uploadInto',
  'copyToClipboard',
  'cutToClipboard',
  'pasteInto',
  // remove
  'detach',
  'trash',
  'restore'
] as const;
export type MaterialActionId = (typeof MATERIAL_ACTION_IDS)[number];

/** The five groups, in the order they are always drawn. */
/**
 * The six, in the order they are always drawn.
 *
 * `place` split out of `organise` when copy, cut and paste joined (024): nine
 * items under one heading is a list nobody reads to the end, and the two halves
 * were answering different questions anyway — what this file is *called* and
 * where it *goes*.
 */
export const MATERIAL_ACTION_GROUPS = [
  'open',
  'get',
  'make',
  'organise',
  'place',
  'remove'
] as const;
export type MaterialActionGroup = (typeof MATERIAL_ACTION_GROUPS)[number];

/** Where the offer is being made. Not a licence to offer a different list. */
export type ActionHost =
  | 'explorer-row'
  | 'explorer-tile'
  | 'explorer-detail'
  | 'search-result'
  | 'task-attachment'
  | 'updater-row'
  | 'selection'
  | 'palette';

/**
 * The little that identifies a material anywhere.
 *
 * Deliberately narrower than any of the four row shapes that satisfy it, so no
 * surface has to widen its query to offer an action. This is the same
 * discipline `RowMaterial` already follows, and the reason file actions escaped
 * the search results once before.
 */
export interface MaterialRef {
  id: string;
  teamId: string;
  name: string;
  kind: MaterialKind;
  category?: string | null;
  parentFolderId?: string | null;
  /**
   * Carried because the file operations need it, not because anything is drawn
   * from it: the download picks the browser or the agent by size, and the
   * analytics bucket is computed from it. A surface that leaves it out makes a
   * large file try the browser path first and reports its size as unknown.
   */
  sizeBytes?: number | null;
  fileExtension?: string | null;
  trashed?: boolean;
  availability?: 'ready' | 'pending' | 'trashed' | 'missing' | 'unavailable';
  transcriptReady?: boolean;
  /** This file came from another, or others came from it, or it is a version. */
  hasLineage?: boolean;
  /** A draft attachment exists only in the open task until it is saved. */
  draft?: boolean;
  companions?: MaterialCompanions;
}

/** What lives beside a material, shown on it wherever it appears. */
export interface MaterialCompanions {
  productCatalog?: { link: string | null; productCount: number | null } | null;
  transcript?: { ready: boolean } | null;
  restitchedPreparedFor?: string | null;
}

export interface ActionContext {
  host: ActionHost;
  permissions: TeamPermissions | null;
  isOwner: boolean;
  currentFolderId?: string | null;
  agentConnected: boolean;
  storageConnected: boolean;
  restitchConfigured: boolean;
  catalogSettingsReady: boolean;
  /** 1 unless the host is the selection bar. */
  selectionSize?: number;
}

/**
 * Why an action that applies cannot run right now.
 *
 * Machine codes, mapped to sentences by the one mapper in `team/errors.ts`.
 * Nothing here is a sentence, for the same reason nothing on the wire is.
 */
export const UNAVAILABLE_REASONS = [
  'NO_PERMISSION',
  'AGENT_REQUIRED',
  'STORAGE_DISCONNECTED',
  'CATALOG_SETTINGS_MISSING',
  'RESTITCH_UNCONFIGURED',
  'NOT_READY',
  'TRASHED',
  'MISSING'
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export type Availability = { ok: true } | { ok: false; reason: UnavailableReason };

const OK: Availability = { ok: true };
const no = (reason: UnavailableReason): Availability => ({ ok: false, reason });

export interface MaterialAction {
  id: MaterialActionId;
  group: MaterialActionGroup;
  /** Position within the group. Stable, so the list reads the same everywhere. */
  order: number;
  labelKey: TranslationKey;
  icon: LucideIcon;
  destructive?: boolean;
  /**
   * How eagerly this wants to be visible without opening a menu. The three
   * highest that apply and are available go inline; the rest stay behind one
   * overflow. `null` means menu only.
   */
  inlinePriority: number | null;
  applies: (material: MaterialRef, context: ActionContext) => boolean;
  available: (material: MaterialRef, context: ActionContext) => Availability;
}

// ── the predicates the table is written in ──────────────────────────────────

const isFolder = (m: MaterialRef) => m.kind === 'folder';
const isFile = (m: MaterialRef) => m.kind !== 'folder';
const isVideo = (m: MaterialRef) => m.category === 'video';
const isLanding = (m: MaterialRef) => m.category === 'landing';
const isText = (m: MaterialRef) => m.category === 'transcript' || m.category === 'text';
/** The explorer's own surfaces: the folder it is showing is already on screen. */
const inExplorer = (c: ActionContext) =>
  c.host === 'explorer-row' || c.host === 'explorer-tile' || c.host === 'explorer-detail';

function may(context: ActionContext, flag: TeamPermissionFlag): Availability {
  return context.permissions?.[flag] ? OK : no('NO_PERMISSION');
}

/** The first failing condition wins, so the reason shown is the nearest one. */
function all(...checks: Availability[]): Availability {
  for (const check of checks) if (!check.ok) return check;
  return OK;
}

function ready(material: MaterialRef): Availability {
  if (material.trashed || material.availability === 'trashed') return no('TRASHED');
  if (material.availability === 'missing') return no('MISSING');
  if (material.availability === 'pending' || material.draft) return no('NOT_READY');
  return OK;
}

const needsAgent = (context: ActionContext): Availability =>
  context.agentConnected ? OK : no('AGENT_REQUIRED');

/**
 * The registry.
 *
 * Order within a group is the order on screen, everywhere. A surface renders
 * this; it does not get to re-sort it, because two screens that order the same
 * six things differently is the thing this replaces.
 */
export const MATERIAL_ACTIONS: readonly MaterialAction[] = [
  // ── Open ──────────────────────────────────────────────────────────────────
  {
    id: 'open',
    group: 'open',
    order: 1,
    labelKey: 'materialActionOpen',
    icon: Eye,
    inlinePriority: 100,
    applies: () => true,
    available: material => ready(material)
  },
  {
    id: 'detail',
    group: 'open',
    order: 2,
    labelKey: 'materialActionDetails',
    icon: SquarePen,
    inlinePriority: null,
    // Not in the updater: `showInFolder` already answers "where does this
    // live", and a dialog that owns the address needs one way out, not two.
    applies: (_material, context) =>
      context.host !== 'explorer-detail' && context.host !== 'updater-row',
    available: () => OK
  },
  {
    id: 'showInFolder',
    group: 'open',
    order: 3,
    labelKey: 'materialActionShowInFolder',
    icon: FolderOpen,
    // Above the download: on a task or in a search result, "where does this
    // live" is asked far more often than "give me the bytes", and it is the
    // action the owner asked for by name.
    inlinePriority: 68,
    // Pointless where you already are; everywhere else it is the way back to
    // the file's home — and it no longer closes the surface asking for it.
    applies: (material, context) => !inExplorer(context) && !material.draft,
    available: material => ready(material)
  },

  // ── Get ───────────────────────────────────────────────────────────────────
  {
    // Where a file came from and what came from it. Lived only in the search
    // results, which is where the lineage happened to be loaded — not where a
    // person happens to want it.
    id: 'provenance',
    group: 'open',
    order: 4,
    labelKey: 'materialActionProvenance',
    icon: GitBranch,
    inlinePriority: null,
    applies: material => Boolean(material.hasLineage),
    available: material => ready(material)
  },

  {
    id: 'copyLink',
    group: 'get',
    order: 1,
    labelKey: 'materialActionCopyLink',
    icon: Link2,
    inlinePriority: 70,
    applies: material => !material.draft,
    available: material => ready(material)
  },
  {
    id: 'share',
    group: 'get',
    order: 2,
    labelKey: 'materialActionShare',
    icon: Share2,
    inlinePriority: null,
    applies: material => !material.draft,
    available: material => ready(material)
  },
  {
    id: 'download',
    group: 'get',
    order: 3,
    labelKey: 'materialActionDownload',
    icon: ArrowDownToLine,
    inlinePriority: 65,
    applies: isFile,
    available: (material, context) => all(ready(material), may(context, 'download'))
  },
  {
    id: 'downloadRestitched',
    group: 'get',
    order: 4,
    labelKey: 'materialActionDownloadRestitched',
    icon: Scissors,
    inlinePriority: null,
    applies: (material, context) =>
      isVideo(material) && !material.draft && context.host !== 'palette',
    available: (material, context) =>
      all(
        ready(material),
        may(context, 'download'),
        needsAgent(context),
        context.restitchConfigured ? OK : no('RESTITCH_UNCONFIGURED')
      )
  },
  {
    id: 'copyText',
    group: 'get',
    order: 5,
    labelKey: 'materialActionCopyText',
    icon: FileText,
    inlinePriority: null,
    applies: material => Boolean(material.companions?.transcript),
    available: material =>
      material.companions?.transcript?.ready ? ready(material) : no('NOT_READY')
  },

  // ── Make ──────────────────────────────────────────────────────────────────
  {
    id: 'productCatalog',
    group: 'make',
    order: 1,
    labelKey: 'materialActionProductCatalog',
    icon: ClipboardList,
    // The owner's example. High enough to be on the tile itself, because
    // reaching it through a menu is most of what was wrong with it.
    inlinePriority: 80,
    applies: (material, context) => isVideo(material) && context.host !== 'selection',
    available: (material, context) =>
      all(
        ready(material),
        may(context, 'upload'),
        context.storageConnected ? OK : no('STORAGE_DISCONNECTED'),
        // An existing catalog can always be opened; only making one needs the
        // space's defaults.
        material.companions?.productCatalog || context.catalogSettingsReady
          ? OK
          : no('CATALOG_SETTINGS_MISSING')
      )
  },
  {
    id: 'transcribe',
    group: 'make',
    order: 2,
    labelKey: 'materialActionTranscribe',
    icon: FileText,
    inlinePriority: null,
    applies: isVideo,
    available: (material, context) =>
      all(ready(material), may(context, 'process'), needsAgent(context))
  },
  {
    id: 'compress',
    group: 'make',
    order: 3,
    labelKey: 'materialActionCompress',
    icon: Minimize2,
    inlinePriority: null,
    applies: isVideo,
    available: (material, context) =>
      all(ready(material), may(context, 'process'), needsAgent(context))
  },
  {
    id: 'process',
    group: 'make',
    order: 4,
    labelKey: 'materialActionProcess',
    icon: Sparkles,
    inlinePriority: null,
    applies: material => isVideo(material) || isLanding(material),
    available: (material, context) =>
      all(ready(material), may(context, 'process'), needsAgent(context))
  },
  {
    id: 'processInside',
    group: 'make',
    order: 5,
    labelKey: 'materialActionProcessInside',
    icon: Sparkles,
    inlinePriority: null,
    applies: isFolder,
    available: (material, context) =>
      all(ready(material), may(context, 'process'), needsAgent(context))
  },
  {
    id: 'regeneratePreview',
    group: 'make',
    order: 6,
    labelKey: 'materialActionRegeneratePreview',
    icon: Sparkles,
    inlinePriority: null,
    applies: isLanding,
    available: (material, context) => all(ready(material), may(context, 'edit'))
  },
  {
    id: 'editText',
    group: 'make',
    order: 7,
    labelKey: 'materialActionEditText',
    icon: PencilLine,
    inlinePriority: null,
    applies: isText,
    available: (material, context) =>
      all(
        ready(material),
        may(context, 'edit'),
        material.transcriptReady === false ? no('NOT_READY') : OK
      )
  },
  // ── Organise ──────────────────────────────────────────────────────────────
  {
    id: 'rename',
    group: 'organise',
    order: 1,
    labelKey: 'materialActionRename',
    icon: PencilLine,
    inlinePriority: null,
    applies: (material, context) => isFile(material) && context.host !== 'selection',
    available: (material, context) => all(ready(material), may(context, 'edit'))
  },
  {
    id: 'move',
    group: 'place',
    order: 1,
    labelKey: 'materialActionMove',
    icon: FolderOpen,
    inlinePriority: null,
    applies: isFile,
    available: (material, context) => all(ready(material), may(context, 'edit'))
  },
  {
    id: 'colourTag',
    group: 'organise',
    order: 2,
    labelKey: 'materialActionColourTag',
    icon: Tags,
    inlinePriority: null,
    applies: isFile,
    available: (material, context) =>
      all(ready(material), context.isOwner ? OK : no('NO_PERMISSION'))
  },
  {
    // Filing the work around a file, rather than making something from it:
    // "Make" is for the artefacts — a catalog, a transcript, a smaller copy.
    id: 'createTask',
    group: 'organise',
    order: 3,
    labelKey: 'materialActionCreateTask',
    icon: ListPlus,
    inlinePriority: null,
    applies: (material, context) => context.host !== 'task-attachment' && !material.draft,
    available: material => ready(material)
  },
  {
    // Onto work that already exists (024, US11). Beside "create a task", because
    // the question is the same — which task is this file for — with two answers.
    id: 'addToTask',
    group: 'organise',
    order: 4,
    labelKey: 'materialActionAddToTask',
    icon: ListPlus,
    inlinePriority: null,
    applies: (material, context) => context.host !== 'task-attachment' && !material.draft,
    available: (material, context) => all(ready(material), may(context, 'edit'))
  },
  {
    id: 'editMetadata',
    group: 'organise',
    order: 5,
    labelKey: 'materialActionEditMetadata',
    icon: SquarePen,
    inlinePriority: null,
    applies: material => isFile(material) && !material.draft,
    available: (material, context) => all(ready(material), may(context, 'manage_metadata'))
  },
  {
    id: 'uploadInto',
    group: 'place',
    order: 5,
    labelKey: 'materialActionUploadInto',
    icon: Upload,
    inlinePriority: null,
    applies: isFolder,
    available: (material, context) => all(ready(material), may(context, 'upload'))
  },
  /*
   * Copy, cut and paste as things you can see (024, FR-055).
   *
   * They existed only as ⌘C / ⌘X / ⌘V, which meant they existed only for
   * whoever had read the code. A file manager puts them in the menu, and the
   * menu is where a person goes when they do not already know the answer.
   *
   * Explorer-only on purpose: pasting is into *the folder you are looking at*,
   * and a task or a search result is not a place.
   */
  {
    id: 'copyToClipboard',
    group: 'place',
    order: 2,
    labelKey: 'materialActionCopy',
    icon: Copy,
    inlinePriority: null,
    applies: (material, context) => inExplorer(context) && !material.draft,
    available: (material, context) => all(ready(material), may(context, 'upload'))
  },
  {
    id: 'cutToClipboard',
    group: 'place',
    order: 3,
    labelKey: 'materialActionCut',
    icon: Scissors,
    inlinePriority: null,
    applies: (material, context) => inExplorer(context) && !material.draft,
    available: (material, context) => all(ready(material), may(context, 'edit'))
  },
  {
    id: 'pasteInto',
    group: 'place',
    order: 4,
    labelKey: 'materialActionPasteInto',
    icon: ClipboardPaste,
    inlinePriority: null,
    // On a folder, because that is the place it lands in. The host supplies
    // the handler only when there is something on the clipboard, and the
    // registry drops an action nothing can perform.
    applies: (material, context) => isFolder(material) && inExplorer(context),
    available: (material, context) => all(ready(material), may(context, 'upload'))
  },

  // ── Remove ────────────────────────────────────────────────────────────────
  {
    id: 'detach',
    group: 'remove',
    order: 1,
    // Never "delete": this takes the file off the task and leaves it on the
    // Drive, and the two were one press apart with nothing to tell them apart.
    labelKey: 'materialActionDetach',
    icon: Undo2,
    destructive: true,
    inlinePriority: 50,
    applies: (_material, context) => context.host === 'task-attachment',
    available: () => OK
  },
  {
    id: 'trash',
    group: 'remove',
    order: 2,
    labelKey: 'materialActionTrash',
    icon: Trash2,
    destructive: true,
    inlinePriority: null,
    applies: (material, context) =>
      isFile(material) && !material.trashed && context.host !== 'task-attachment',
    available: (material, context) => all(ready(material), may(context, 'delete'))
  },
  {
    id: 'restore',
    group: 'remove',
    order: 3,
    labelKey: 'materialActionRestore',
    icon: Undo2,
    inlinePriority: 90,
    applies: material => Boolean(material.trashed || material.availability === 'trashed'),
    available: (_material, context) => may(context, 'delete')
  }
];

/** By id, for a surface that needs to ask about one action by name. */
export const MATERIAL_ACTION_BY_ID = new Map<MaterialActionId, MaterialAction>(
  MATERIAL_ACTIONS.map(action => [action.id, action])
);

/**
 * The space a surface is acting inside, found by id rather than by what is
 * "active".
 *
 * A tile, a row and a search result are each about one space, and they are
 * given its id. Reading the *active* space instead happens to be the same thing
 * in the product — there is only ever one open — and is not the same thing at
 * all in a test that renders the component on its own, where nothing has been
 * entered and the permissions come back null. A control that silently believes
 * it may do nothing is the hardest kind of bug to see.
 */
export function spaceOf<T extends { id: string }>(
  teams: readonly T[],
  activeTeam: T | null,
  teamId: string
): T | null {
  return teams.find(team => team.id === teamId) ?? activeTeam;
}
