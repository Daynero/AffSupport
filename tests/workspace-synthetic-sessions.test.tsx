// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import { getSupabaseClient } from '../apps/web/src/lib/supabase';
import { TeamProvider, useTeam } from '../apps/web/src/team/TeamContext';
import { useTasks } from '../apps/web/src/team/tasks/useTasks';
import { useFolderPage } from '../apps/web/src/team/explorer/useFolderPage';
import { useCatalogSearch } from '../apps/web/src/team/catalog/useCatalogSearch';

vi.mock('../apps/web/src/lib/supabase', () => ({ getSupabaseClient: vi.fn() }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// The real hooks run; RPC/Realtime/auth/browser processes do not. Timings use a
// controlled fake clock and cannot establish production latency or capacity.
describe.each([3, 10])('%i synthetic workspace sessions', sessions => {
  it.each(['shared', 'separate'] as const)(
    'keeps catalog traffic scoped while listing and searching in %s teams',
    async topology => {
      vi.useFakeTimers();
      const callbacks: Array<{ table: string; callback: () => void }> = [];
      vi.mocked(getSupabaseClient).mockReturnValue({
        channel: vi.fn(() => {
          const channel = {
            on: vi.fn((_: string, filter: { table: string }, callback: () => void) => {
              callbacks.push({ table: filter.table, callback });
              return channel;
            }),
            subscribe: vi.fn(() => channel)
          };
          return channel;
        }),
        removeChannel: vi.fn().mockResolvedValue(undefined)
      } as unknown as ReturnType<typeof getSupabaseClient>);
      let version = 0;
      const rpcDurations: number[] = [];
      const reply = <T,>(value: T) => {
        const started = Date.now();
        return new Promise<T>(resolve => {
          setTimeout(() => {
            rpcDurations.push(Date.now() - started);
            resolve(value);
          }, 25);
        });
      };
      const views = Array.from({ length: sessions }, (_, index) => {
        const team = {
          id: `21000000-0000-4000-8000-${String(topology === 'shared' ? 1 : index + 1).padStart(12, '0')}`,
          name: 'Synthetic',
          role: 'owner' as const,
          permissions: DEFAULT_ROLE_PERMISSIONS.owner,
          connectionState: 'connected' as const
        };
        const client = {
          listTeams: vi.fn(() => reply([team])),
          listTasks: vi.fn(() => reply([])),
          listFolderPage: vi.fn(() => reply({ rows: [], total: version, next: null })),
          searchCatalog: vi.fn(() =>
            reply({
              items: [],
              total: version,
              activeFilters: {},
              facets: {},
              catalogFreshness: {
                state: 'scanning' as const,
                lastSyncedAt: null,
                discoveredCount: version,
                foldersRemaining: 1,
                lastProgressAt: null
              }
            })
          ),
          getCatalogVocabulary: vi.fn(() => reply({ geo: [], languages: [], offers: [], tags: [] }))
        };
        localStorage.setItem('wishly.active-team.v1', team.id);
        window.history.replaceState(null, '', `/team/${team.id}`);
        const view = renderHook(
          () => {
            const context = useTeam();
            useTasks({ teamId: team.id, revision: context.tasksRevision, client: client as never });
            const folder = useFolderPage({
              teamId: team.id,
              client,
              parentFolderId: null,
              revision: context.revision
            });
            const search = useCatalogSearch({ teamId: team.id, client, debounceMs: 0 });
            return { folder, search };
          },
          {
            wrapper: ({ children }) => (
              <TeamProvider initialTeams={[team]} client={client}>
                {children}
              </TeamProvider>
            )
          }
        );
        return { client, view };
      });
      const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));
      await advance(100);
      const baseline = views.map(({ client }) => ({
        tasks: client.listTasks.mock.calls.length,
        teams: client.listTeams.mock.calls.length,
        folders: client.listFolderPage.mock.calls.length,
        searches: client.searchCatalog.mock.calls.length
      }));
      const visibleUpperBounds: number[] = [];
      for (let tick = 1; tick <= 10; tick++) {
        version = tick;
        const started = Date.now();
        act(() => {
          callbacks
            .filter(event => event.table === 'team_catalog_events')
            .forEach(event => event.callback());
        });
        await advance(1000);
        await advance(25);
        await advance(25);
        for (const { view } of views) {
          expect(view.result.current.folder.total).toBe(tick);
          expect(view.result.current.search.result?.total).toBe(tick);
          visibleUpperBounds.push(Date.now() - started);
        }
      }
      let extraTasks = 0,
        extraTeams = 0,
        folderReads = 0,
        searchReads = 0;
      views.forEach(({ client }, index) => {
        extraTasks += client.listTasks.mock.calls.length - baseline[index].tasks;
        extraTeams += client.listTeams.mock.calls.length - baseline[index].teams;
        folderReads += client.listFolderPage.mock.calls.length - baseline[index].folders;
        searchReads += client.searchCatalog.mock.calls.length - baseline[index].searches;
      });
      expect(extraTasks).toBe(0);
      expect(extraTeams).toBe(0);
      expect(folderReads).toBe(10 * sessions);
      expect(searchReads).toBe(10 * sessions);
      const p95 = (values: number[]) =>
        [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
      console.log(
        JSON.stringify({
          scope: 'controlled_hooks_only',
          sessions,
          topology,
          catalog_ticks: 10,
          extra_task_reads: extraTasks,
          extra_team_reads: extraTeams,
          required_folder_reads: folderReads,
          required_search_reads: searchReads,
          controlled_rpc_p95_ms: p95(rpcDurations),
          controlled_visible_p95_upper_bound_ms: p95(visibleUpperBounds)
        })
      );
    }
  );
});
