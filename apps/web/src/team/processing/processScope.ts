import { useEffect, useMemo, useRef, useState } from 'react';
import type { FolderSubtree, TeamMaterialSummary } from '../../api/team';
import type { LibraryBatchScope } from '../library/process-library-contract';

/**
 * How many files one batch may name. The server bounds the scope array at the
 * same number; without a check here a folder of six hundred came back as
 * "Частина даних некоректна. Перевірте поля" in a window that has no fields.
 */
export const BATCH_SCOPE_LIMIT = 500;

/** The one read a folder scope needs: everything a batch can take under it. */
export interface FolderSubtreeClient {
  listFolderSubtree: (teamId: string, rootFolderId: string) => Promise<FolderSubtree>;
}

/**
 * What the batch needs to know about a folder: its name, to say what it is
 * about to work through, and its drive id, to walk it. A row from the list and
 * a node from the tree both answer that.
 */
export interface ProcessableFolder {
  driveFileId: string;
  name: string;
}

/** A file in hand: what a selection, a row or a result can say about itself. */
export interface ScopeFile {
  id: string;
  name: string;
  category?: string | null;
  parentFolderId?: string | null;
}

export type ProcessIntent = 'process' | 'compress';
export type ProcessScopeKind = 'selection' | 'folder' | 'space';

/**
 * Where "process" or "compress" was pressed (070, T061).
 *
 * One dialog behind every door: the door decides which scope it opens on, and
 * hands over every other scope it can name — the folder the person is in, the
 * files they have ticked — so the choice is in the dialog rather than in which
 * menu they happened to open.
 */
export interface ProcessOrigin {
  intent: ProcessIntent;
  initial: ProcessScopeKind;
  /** The files in hand; one file reads as "this file". */
  selection?: readonly ScopeFile[] | null;
  /** How many were picked, when some of `selection` cannot be processed. */
  picked?: number;
  folder?: ProcessableFolder | null;
  /** Whether "the whole space" may be offered — processing only. */
  space?: boolean;
}

/** The answer for the chosen scope, before anything starts. */
export type ScopeResolution =
  | { state: 'walking' }
  | { state: 'failed' }
  /** Nothing this intent can take: Start stays off, and the line says why. */
  | { state: 'empty'; reason: 'folder' | 'selection'; foldersVisited?: number }
  /** The walk hit its ceiling before it found anything to hand over. */
  | { state: 'too-deep'; foldersVisited: number }
  | { state: 'too-many'; count: number }
  | {
      state: 'ready';
      /** The ids a batch runs over; empty only for the whole space. */
      ids: string[];
      /** The videos, for compression — named and placed. */
      videos: ScopeFile[];
      library: LibraryBatchScope;
      /** The walk stopped at its ceiling: what was found is all that is offered. */
      truncatedAfter?: number;
    };

/* What the batch can take: a folder, a transcript or an image can be ticked like anything else. */
const PROCESSABLE = new Set(['video', 'landing']);

/** The scopes this door can offer, in reading order: the narrowest first. */
export function scopesOf(origin: ProcessOrigin): ProcessScopeKind[] {
  const kinds: ProcessScopeKind[] = [];
  if (origin.selection && origin.selection.length > 0) kinds.push('selection');
  if (origin.folder) kinds.push('folder');
  if (origin.intent === 'process' && origin.space) kinds.push('space');
  if (!kinds.includes(origin.initial)) kinds.unshift(origin.initial);
  return kinds;
}

/**
 * The selection, read without a request: what it holds that this intent can
 * take, and whether that is too many for one batch.
 */
export function resolveSelection(
  origin: ProcessOrigin,
  selection: readonly ScopeFile[]
): ScopeResolution {
  const videos = selection.filter(file => file.category === 'video');
  if (origin.intent === 'compress') {
    if (videos.length === 0) return { state: 'empty', reason: 'selection' };
    return { state: 'ready', ids: videos.map(file => file.id), videos, library: { kind: 'space' } };
  }
  /* A selection the explorer already narrowed carries no categories: every file in it counts. */
  const processable = selection.filter(
    file => file.category === undefined || PROCESSABLE.has(file.category ?? '')
  );
  if (processable.length === 0) return { state: 'empty', reason: 'selection' };
  /* The bound the folder path already respects: refused here it is a sentence;
     refused by the RPC it is "Частина даних некоректна" in a window with no fields. */
  if (processable.length > BATCH_SCOPE_LIMIT)
    return { state: 'too-many', count: processable.length };
  const picked = origin.picked ?? selection.length;
  return {
    state: 'ready',
    ids: processable.map(file => file.id),
    videos,
    library: {
      kind: 'selection',
      count: processable.length,
      ...(processable.length < picked ? { picked } : {})
    }
  };
}

/**
 * A folder's subtree, read once, turned into an answer (the five that
 * `FolderScopeDialog` used to give, in the order that keeps each one true).
 *
 * A read that stopped at the ceiling has not seen the folder, so it can never
 * say the folder is empty — and with nothing found it has nothing to hand over
 * either: an empty scope is read by the server as the whole space, so that path
 * asks the person to go deeper instead. The size bound comes before the
 * truncation notice, or a cut-short read over six hundred files would offer to
 * process all of them and be refused by the RPC.
 */
export function resolveSubtree(
  intent: ProcessIntent,
  folder: ProcessableFolder,
  result: FolderSubtree
): ScopeResolution {
  const found =
    intent === 'compress' ? result.videos.length : result.videos.length + result.landings.length;
  if (found === 0 && result.truncated)
    return { state: 'too-deep', foldersVisited: result.foldersVisited };
  if (found === 0)
    return { state: 'empty', reason: 'folder', foldersVisited: result.foldersVisited };
  // Only the batch has a five-hundred bound: compression and preview refreshes
  // run file by file from this device and are not capped.
  if (intent === 'process' && found > BATCH_SCOPE_LIMIT) return { state: 'too-many', count: found };
  const videos = result.videos.map(video => toScopeFile(video, folder));
  const ids = [...result.videos, ...result.landings].map(item => item.id);
  return {
    state: 'ready',
    ids: intent === 'compress' ? videos.map(video => video.id) : ids,
    videos,
    library: {
      kind: 'folder',
      name: folder.name,
      // The walk counts the folder it started from; a folder with five
      // subfolders was reporting six.
      folders: Math.max(0, result.foldersVisited - 1),
      files: ids.length,
      // Separately, because the window's "already done" line is about videos
      // with a transcript, and one video is exactly one transcription job.
      videos: result.videos.length,
      landingIds: result.landings.map(landing => landing.id)
    },
    ...(result.truncated ? { truncatedAfter: result.foldersVisited } : {})
  };
}

function toScopeFile(item: TeamMaterialSummary, folder: ProcessableFolder): ScopeFile {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    parentFolderId: item.parentFolderId ?? folder.driveFileId
  };
}

/** Two scopes name the same batch: the same kind, the same words. */
export function sameLibraryScope(left: LibraryBatchScope, right: LibraryBatchScope): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'folder' && right.kind === 'folder')
    return left.name === right.name && left.files === right.files;
  if (left.kind === 'selection' && right.kind === 'selection') return left.count === right.count;
  return true;
}

/**
 * The chosen scope and its answer. The folder is read once per folder, on the
 * first time it is chosen, and kept: switching back and forth does not walk it
 * again.
 */
export function useProcessScope(
  teamId: string,
  origin: ProcessOrigin,
  client: FolderSubtreeClient
) {
  const kinds = useMemo(() => scopesOf(origin), [origin]);
  const [kind, setKind] = useState<ProcessScopeKind>(origin.initial);
  const [subtree, setSubtree] = useState<
    { state: 'idle' | 'walking' | 'failed' } | { state: 'done'; result: FolderSubtree }
  >({ state: 'idle' });
  const folder = origin.folder ?? null;
  const wantsFolder = kind === 'folder' && folder !== null;
  /* Answers kept by folder: coming back to "this folder" does not walk it again. */
  const walked = useRef(new Map<string, FolderSubtree>());

  useEffect(() => {
    if (!wantsFolder || !folder) return;
    const id = folder.driveFileId;
    const known = walked.current.get(id);
    if (known) {
      setSubtree({ state: 'done', result: known });
      return;
    }
    let active = true;
    setSubtree({ state: 'walking' });
    void client
      .listFolderSubtree(teamId, id)
      .then(result => {
        walked.current.set(id, result);
        if (active) setSubtree({ state: 'done', result });
      })
      .catch(() => {
        if (active) setSubtree({ state: 'failed' });
      });
    return () => {
      active = false;
    };
  }, [client, folder, teamId, wantsFolder]);

  const resolution = useMemo<ScopeResolution>(() => {
    if (kind === 'space')
      return { state: 'ready', ids: [], videos: [], library: { kind: 'space' } };
    if (kind === 'selection') return resolveSelection(origin, origin.selection ?? []);
    if (!folder) return { state: 'failed' };
    if (subtree.state === 'done') return resolveSubtree(origin.intent, folder, subtree.result);
    if (subtree.state === 'failed') return { state: 'failed' };
    return { state: 'walking' };
  }, [folder, kind, origin, subtree]);

  const folderCounts = subtree.state === 'done' ? subtree.result : null;
  return { kinds, kind, setKind, resolution, folderCounts };
}

export type ProcessScopeState = ReturnType<typeof useProcessScope>;
