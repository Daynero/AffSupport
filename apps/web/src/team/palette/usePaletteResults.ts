import { useEffect, useRef, useState } from 'react';
import type { TeamTaskStatus } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import type { PaletteResult } from './WorkspacePalette';
import { folderPathLabel, indexFolders, type FolderPathNode } from '../explorer/folderPath';
import { translate, type Language } from '../../i18n';
import { readRecent, rememberRecent } from './recent';

/**
 * What the palette finds, and how it avoids getting in the way (024, FR-098).
 *
 * Four sources, three of them already in memory: the folder tree the explorer
 * holds, the board's tasks, the space's accounts. Only the files need the
 * server, and a catalog search over a large space is the one call here that
 * can take a moment.
 *
 * So: a pause before asking, one request in flight at a time, and the answer
 * from a query that is no longer in the field is dropped rather than rendered.
 * The in-memory sources are filtered on every keystroke without waiting for
 * any of that — a task you can already see should not take 250ms to appear.
 */

const PAUSE_MS = 220;
const PER_GROUP = 6;

export interface PaletteSources {
  teamId: string;
  /** What each result does when it is chosen. */
  openMaterial: (input: { id: string; name: string; parentFolderId: string | null }) => void;
  openFolder: (driveFileId: string) => void;
  openTask: (id: string) => void;
  openAccount: (id: string) => void;
  /** For the root folder's name in a path. */
  language?: Language;
}

interface Small {
  folders: Array<{ id: string; driveFileId: string; parentFolderId: string | null; name: string }>;
  tasks: Array<{ id: string; title: string; note: string | null; status: TeamTaskStatus }>;
  accounts: Array<{ id: string; name: string }>;
}

const NOTHING: Small = { folders: [], tasks: [], accounts: [] };

/**
 * A product catalog sheet, as its name says: `IN 40_v2_catalog`, or `clip catalog` from before
 * variations, with Drive's `(2)` when a name was taken. The search row carries no companion kind,
 * and the naming rule is ours (022, 024), so the name is a reliable enough witness for a label.
 */
export function isCatalogSheet(name: string, mimeType: string | null | undefined): boolean {
  return (
    mimeType === 'application/vnd.google-apps.spreadsheet' &&
    /(?:_v\d+_catalog| catalog)(?: \(\d+\))?$/iu.test(name)
  );
}

function matchesTerm(value: string, term: string): boolean {
  return value.toLocaleLowerCase().includes(term);
}

/**
 * Closest first, the way Raycast and Linear order a jump list: the name that *is* the query (its
 * extension aside), then names that start with it, then words that do, then the rest — shorter
 * before longer inside each. "Db3_2" listed `Db3_2_compressed_2.mp4` above `Db3_2.mp4`.
 */
export function rankByName<T>(items: readonly T[], term: string, nameOf: (item: T) => string): T[] {
  const score = (name: string) => {
    const lower = name.toLocaleLowerCase();
    const stem = lower.replace(/\.[^.]+$/u, '');
    if (lower === term || stem === term) return 0;
    if (lower.startsWith(term)) return 1;
    if (
      new RegExp(`(^|[\\s_\\-.])${term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u').test(lower)
    ) {
      return 2;
    }
    return 3;
  };
  return items
    .map((item, index) => ({ item, index, name: nameOf(item) }))
    .sort(
      (a, b) => score(a.name) - score(b.name) || a.name.length - b.name.length || a.index - b.index
    )
    .map(entry => entry.item);
}

export function usePaletteResults(
  query: string,
  sources: PaletteSources
): { results: PaletteResult[]; loading: boolean } {
  const [remote, setRemote] = useState<PaletteResult[]>([]);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  const at = useRef(sources);
  at.current = sources;
  const foldersRef = useRef<ReadonlyMap<string, FolderPathNode>>(new Map());
  const languageRef = useRef<Language>(sources.language ?? 'en');
  languageRef.current = sources.language ?? 'en';

  /*
   * The three small lists, read once when the palette opens rather than on
   * every keystroke: a space has tens of folders, tens of tasks and a handful
   * of accounts, and holding them for the life of one dialog costs nothing.
   * Files are the exception — there can be thousands, so those stay a search.
   */
  const [small, setSmall] = useState<Small>(NOTHING);
  const { teamId } = sources;
  useEffect(() => {
    let active = true;
    void Promise.all([
      teamApi.listFolderTree(teamId).catch(() => []),
      teamApi.listTasks({ teamId }).catch(() => []),
      teamApi.listAccounts(teamId).catch(() => [])
    ]).then(([folders, tasks, accounts]) => {
      if (!active) return;
      foldersRef.current = indexFolders(
        folders.map(node => ({
          driveFileId: node.driveFileId,
          parentFolderId: node.parentFolderId,
          name: node.name
        }))
      );
      setSmall({
        folders: folders.map(node => ({
          id: node.id,
          driveFileId: node.driveFileId,
          parentFolderId: node.parentFolderId,
          name: node.name
        })),
        tasks: tasks.map(task => ({
          id: task.id,
          title: task.title,
          note: task.note,
          status: task.status
        })),
        accounts: accounts.map(account => ({ id: account.id, name: account.name }))
      });
    });
    return () => {
      active = false;
    };
  }, [teamId]);

  const term = query.normalize('NFC').trim().toLocaleLowerCase();

  useEffect(() => {
    if (term.length < 2) {
      setRemote([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const token = ++latest.current;
    const timer = window.setTimeout(() => {
      void teamApi
        .searchCatalog(at.current.teamId, { query: term, page: 1, pageSize: PER_GROUP })
        .then(found => {
          // A late answer to a question nobody is asking any more.
          if (token !== latest.current) return;
          setRemote(
            rankByName(found.items, term, item => item.name).map(item => ({
              id: `material:${item.id}`,
              kind: 'material' as const,
              name: item.name,
              facts: {
                // The folder first: it is what tells same-named files apart (024).
                path: folderPathLabel(
                  item.parentFolderId,
                  foldersRef.current,
                  translate(languageRef.current, 'teamExplorerRootLabel')
                ),
                category: item.category,
                sizeBytes: item.sizeBytes,
                catalog: isCatalogSheet(item.name, item.mimeType)
              },
              run: () => {
                rememberRecent(at.current.teamId, {
                  kind: 'material',
                  id: item.id,
                  name: item.name,
                  parentFolderId: item.parentFolderId ?? null
                });
                at.current.openMaterial({
                  id: item.id,
                  name: item.name,
                  parentFolderId: item.parentFolderId ?? null
                });
              }
            }))
          );
        })
        .catch(() => {
          if (token === latest.current) setRemote([]);
        })
        .finally(() => {
          if (token === latest.current) setLoading(false);
        });
    }, PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [term]);

  if (term === '') {
    // An empty field is where you left off (024): the last things opened, most recent first.
    const rootLabel = translate(languageRef.current, 'teamExplorerRootLabel');
    return {
      results: readRecent(teamId).map(entry => ({
        id: `recent:${entry.kind}:${entry.id}`,
        kind: entry.kind,
        recent: true,
        name: entry.name,
        ...(entry.kind === 'material'
          ? {
              facts: { path: folderPathLabel(entry.parentFolderId, foldersRef.current, rootLabel) }
            }
          : {}),
        run: () => {
          rememberRecent(teamId, entry);
          if (entry.kind === 'task') at.current.openTask(entry.id);
          else if (entry.kind === 'account') at.current.openAccount(entry.id);
          else if (entry.kind === 'folder') at.current.openFolder(entry.driveFileId ?? entry.id);
          else
            at.current.openMaterial({
              id: entry.id,
              name: entry.name,
              parentFolderId: entry.parentFolderId ?? null
            });
        }
      })),
      loading: false
    };
  }

  const local: PaletteResult[] = [
    ...rankByName(
      small.folders.filter(folder => matchesTerm(folder.name, term)),
      term,
      folder => folder.name
    )
      .slice(0, PER_GROUP)
      .map(folder => ({
        id: `folder:${folder.id}`,
        kind: 'folder' as const,
        name: folder.name,
        run: () => {
          rememberRecent(teamId, {
            kind: 'folder',
            id: folder.id,
            name: folder.name,
            driveFileId: folder.driveFileId
          });
          at.current.openFolder(folder.driveFileId);
        }
      })),
    ...rankByName(
      small.tasks.filter(
        task => matchesTerm(task.title, term) || matchesTerm(task.note ?? '', term)
      ),
      term,
      task => task.title
    )
      .slice(0, PER_GROUP)
      .map(task => ({
        id: `task:${task.id}`,
        kind: 'task' as const,
        name: task.title,
        facts: { status: task.status },
        run: () => {
          rememberRecent(teamId, { kind: 'task', id: task.id, name: task.title });
          at.current.openTask(task.id);
        }
      })),
    ...rankByName(
      small.accounts.filter(account => matchesTerm(account.name, term)),
      term,
      account => account.name
    )
      .slice(0, PER_GROUP)
      .map(account => ({
        id: `account:${account.id}`,
        kind: 'account' as const,
        name: account.name,
        run: () => {
          rememberRecent(teamId, { kind: 'account', id: account.id, name: account.name });
          at.current.openAccount(account.id);
        }
      }))
  ];

  return { results: [...remote, ...local], loading };
}
