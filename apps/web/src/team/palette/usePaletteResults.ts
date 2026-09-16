import { useEffect, useRef, useState } from 'react';
import { teamApi } from '../../api/team';
import type { PaletteResult } from './WorkspacePalette';

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
}

interface Small {
  folders: Array<{ id: string; driveFileId: string; name: string }>;
  tasks: Array<{ id: string; title: string; note: string | null }>;
  accounts: Array<{ id: string; name: string }>;
}

const NOTHING: Small = { folders: [], tasks: [], accounts: [] };

function matchesTerm(value: string, term: string): boolean {
  return value.toLocaleLowerCase().includes(term);
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
      setSmall({
        folders: folders.map(node => ({
          id: node.id,
          driveFileId: node.driveFileId,
          name: node.name
        })),
        tasks: tasks.map(task => ({ id: task.id, title: task.title, note: task.note })),
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
            found.items.map(item => ({
              id: `material:${item.id}`,
              kind: 'material' as const,
              name: item.name,
              run: () =>
                at.current.openMaterial({
                  id: item.id,
                  name: item.name,
                  parentFolderId: item.parentFolderId ?? null
                })
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

  if (term === '') return { results: [], loading: false };

  const local: PaletteResult[] = [
    ...small.folders
      .filter(folder => matchesTerm(folder.name, term))
      .slice(0, PER_GROUP)
      .map(folder => ({
        id: `folder:${folder.id}`,
        kind: 'folder' as const,
        name: folder.name,
        run: () => at.current.openFolder(folder.driveFileId)
      })),
    ...small.tasks
      .filter(task => matchesTerm(task.title, term) || matchesTerm(task.note ?? '', term))
      .slice(0, PER_GROUP)
      .map(task => ({
        id: `task:${task.id}`,
        kind: 'task' as const,
        name: task.title,
        run: () => at.current.openTask(task.id)
      })),
    ...small.accounts
      .filter(account => matchesTerm(account.name, term))
      .slice(0, PER_GROUP)
      .map(account => ({
        id: `account:${account.id}`,
        kind: 'account' as const,
        name: account.name,
        run: () => at.current.openAccount(account.id)
      }))
  ];

  return { results: [...remote, ...local], loading };
}
