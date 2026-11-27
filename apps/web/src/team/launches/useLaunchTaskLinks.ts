import { useCallback, useEffect, useRef, useState } from 'react';
import { teamApi, type TeamLaunchTaskLink } from '../../api/team';

type LinksClient = Pick<typeof teamApi, 'listLaunchTasks'>;

/**
 * 076 US3 — which task each launch on the board is in, for the chip on its card.
 *
 * Read for the launches on screen, a hundred at a time, and again after the board
 * puts launches into a task. A failed read leaves the chips off: they are a way to
 * the task, not a fact the board depends on.
 */
export function useLaunchTaskLinks(
  teamId: string,
  launchIds: readonly string[],
  client: LinksClient = teamApi
): { links: ReadonlyMap<string, TeamLaunchTaskLink[]>; refresh: () => void } {
  const [links, setLinks] = useState<ReadonlyMap<string, TeamLaunchTaskLink[]>>(new Map());
  const [round, setRound] = useState(0);
  const key = launchIds.join(',');
  const latest = useRef(0);

  useEffect(() => {
    if (!key) {
      setLinks(new Map());
      return;
    }
    const ids = key.split(',');
    const request = ++latest.current;
    const chunks: string[][] = [];
    for (let offset = 0; offset < ids.length; offset += 100)
      chunks.push(ids.slice(offset, offset + 100));
    // A client without the read (an older test double, a preview) simply shows no chips.
    if (typeof client.listLaunchTasks !== 'function') return;
    void Promise.all(
      chunks.map(chunk => Promise.resolve().then(() => client.listLaunchTasks(teamId, chunk)))
    )
      .then(results => {
        if (request !== latest.current) return;
        const next = new Map<string, TeamLaunchTaskLink[]>();
        for (const link of results.flat()) {
          const list = next.get(link.launchId) ?? [];
          list.push(link);
          next.set(link.launchId, list);
        }
        setLinks(next);
      })
      .catch(() => {
        /* the chips stay as they were */
      });
  }, [client, key, round, teamId]);

  const refresh = useCallback(() => setRound(value => value + 1), []);
  return { links, refresh };
}
