import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseTeamFileOperationResult, type TeamErrorCode } from '@video-compressor/shared';
import type { TeamTrashedMaterial } from '../../api/team';
import { teamApi, TeamApiError } from '../../api/team';
import { privateClientId, usePrivateCacheEpoch } from '../private-cache-scope';
import { captureCatalogMutationOwner } from '../catalog-updater/captureCatalogMutationOwner';
import { withReadDeadline } from '../readCoordinator';
import { WorkspaceMutationJournal } from '../workspace/mutationJournal';
import { withCatalogCommandDeadline as withMutationDeadline } from '../catalog-updater/catalogCommandCoordinator';

import { LabeledSkeleton } from '../../components/LabeledSkeleton';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { teamErrorCodeOf, teamErrorMessageFor } from '../errors';
import {
  beginWorkspaceOperation,
  type WorkspaceOperationFlow
} from '../workspace/operationAnalytics';
import { formatDate } from '../../format';
import { KindIcon } from '../explorer/KindIcon';
import {
  Button,
  EmptyState,
  Table,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow
} from '../../components/ui/index';

export interface TrashViewClient {
  listTrashedMaterials: (input: {
    teamId: string;
    limit?: number;
    before?: string | null;
    beforeId?: string | null;
    signal?: AbortSignal;
  }) => Promise<TeamTrashedMaterial[]>;
  restoreMaterial: (input: {
    teamId: string;
    materialId: string;
    idempotencyKey: string;
    expectedActorId?: string;
  }) => Promise<unknown>;
}

const defaultClient: TrashViewClient = teamApi;
const PAGE_SIZE = 50;

/**
 * What has been trashed, and the way back.
 *
 * Undo covers the seconds after a mistake; this covers the hours after it,
 * which is when most people notice (finding R2). Paged by the timestamp and identity of the
 * last row rather than by offset, so restoring something mid-scroll cannot
 * shift the window and hide a neighbour.
 */
export function TrashView(props: Parameters<typeof TrashViewScope>[0]) {
  const epoch = usePrivateCacheEpoch();
  return (
    <TrashViewScope
      key={`${props.teamId}:${privateClientId(props.client ?? defaultClient)}:${epoch}`}
      {...props}
    />
  );
}

function TrashViewScope({
  teamId,
  client = defaultClient
}: {
  teamId: string;
  client?: TrashViewClient;
}) {
  const mounted = useRef(true);
  const requestControllers = useRef(new Set<AbortController>());
  const owner = useMemo(() => captureCatalogMutationOwner(() => mounted.current), []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of requestControllers.current) controller.abort();
      requestControllers.current.clear();
    };
  }, []);
  const { t, language } = useI18n();
  const { push, toasts } = useToasts();
  const [items, setItems] = useState<TeamTrashedMaterial[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const restoreFlows = useRef(new Map<string, WorkspaceOperationFlow>());
  const restoreFeedback = useRef(
    new Map<
      number,
      {
        key: string;
        flow: WorkspaceOperationFlow;
        outcome: 'success' | 'failure' | 'unknown';
        code?: TeamErrorCode | 'UNKNOWN';
      }
    >()
  );
  useEffect(() => {
    if (!owner.current()) return;
    for (const toast of toasts) {
      const feedback = restoreFeedback.current.get(toast.id);
      if (!feedback) continue;
      feedback.flow.visibleResult(feedback.outcome, feedback.code);
      restoreFeedback.current.delete(toast.id);
      if (feedback.outcome !== 'unknown') restoreFlows.current.delete(feedback.key);
    }
  }, [toasts, owner]);
  useEffect(
    () => () => {
      restoreFlows.current.clear();
      restoreFeedback.current.clear();
    },
    []
  );
  const restoring = useRef(false);
  const readId = useRef(0);
  const morePending = useRef(false);

  const load = useCallback(
    async (before: string | null, beforeId: string | null = null) => {
      if (!owner.current()) return;
      const read = ++readId.current;
      const controller = new AbortController();
      requestControllers.current.add(controller);
      try {
        const page = await withReadDeadline(
          signal =>
            client.listTrashedMaterials({ teamId, limit: PAGE_SIZE, before, beforeId, signal }),
          controller.signal
        );
        if (!owner.current() || read !== readId.current) return;
        setFailed(false);
        setExhausted(page.length < PAGE_SIZE);
        setItems(current => (before === null ? page : [...(current ?? []), ...page]));
      } finally {
        requestControllers.current.delete(controller);
      }
    },
    [client, teamId, owner]
  );

  useEffect(() => {
    let active = true;
    setItems(null);
    setFailed(false);
    setExhausted(false);
    void load(null).catch(() => {
      if (active && owner.current()) setFailed(true);
    });
    return () => {
      active = false;
    };
  }, [load, owner]);

  const requestPage = (before: string | null, beforeId: string | null = null) => {
    if (!owner.current() || morePending.current) return;
    morePending.current = true;
    setLoadingMore(true);
    void load(before, beforeId)
      .catch(() => {
        if (owner.current()) setFailed(true);
      })
      .finally(() => {
        morePending.current = false;
        if (owner.current()) setLoadingMore(false);
      });
  };

  const restore = async (item: TeamTrashedMaterial) => {
    if (!owner.current() || restoring.current) return;
    restoring.current = true;
    let key = '';
    let flow: WorkspaceOperationFlow | undefined;
    const controller = new AbortController();
    requestControllers.current.add(controller);
    let knownFailure = false;
    setRestoringId(item.id);
    try {
      const journal = new WorkspaceMutationJournal(
        'restore',
        owner.options().expectedActorId,
        teamId,
        localStorage
      );
      key = journal.acquire([item.id]).id;
      flow = restoreFlows.current.get(key) ?? beginWorkspaceOperation('restore', key, 1);
      restoreFlows.current.set(key, flow);
      flow.stage('running');
      const reply = await withMutationDeadline(
        () =>
          client.restoreMaterial({
            teamId,
            materialId: item.id,
            idempotencyKey: key,
            ...owner.options()
          }),
        controller.signal
      );
      if (!owner.current()) return;
      const result = parseTeamFileOperationResult(reply);
      if (!result || (result.materialId !== null && result.materialId !== item.id))
        throw new TeamApiError('INVALID_RESPONSE', false);
      flow.receipt(result.operationId);
      if (result.state === 'failed' || result.state === 'canceled') {
        knownFailure = true;
        throw new TeamApiError(
          result.state === 'canceled' ? 'PROCESS_CANCELED' : 'PROCESS_FAILED',
          false
        );
      }
      if (result.state !== 'succeeded') throw new TeamApiError('PROCESS_RESULT_UNCERTAIN', true);
      flow.stage('confirmed');
      journal.confirmed(key);
      setItems(current => (current ?? []).filter(row => row.id !== item.id));
      const toast = push({ tone: 'success', text: t('teamToastRestored') });
      restoreFeedback.current.set(toast, { key, flow, outcome: 'success' });
    } catch (cause) {
      if (owner.current()) {
        const code = teamErrorCodeOf(cause) ?? 'UNKNOWN';
        flow?.diagnostic('restore_request', cause);
        flow?.stage(knownFailure ? 'rejected' : 'unknown', code === 'UNKNOWN' ? undefined : code);
        const toast = push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
        if (flow)
          restoreFeedback.current.set(toast, {
            key,
            flow,
            code,
            outcome: knownFailure ? 'failure' : 'unknown'
          });
      }
    } finally {
      requestControllers.current.delete(controller);
      restoring.current = false;
      if (owner.current()) setRestoringId(null);
    }
  };

  return (
    <section className="team-trash-view" aria-labelledby="team-trash-title">
      <div className="team-panel-heading">
        <h2 id="team-trash-title">{t('teamTrashTitle')}</h2>
      </div>
      {/* Honest about what this is: Drive's own retention decides how long a
          trashed file can still be restored, and this view cannot change that. */}
      <p className="team-trash-note">{t('teamTrashRetentionNote')}</p>

      {items === null && !failed && <LabeledSkeleton label="teamTrashLoading" rows={3} />}
      {failed && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="team-inline-error" role="alert">
            {t('teamTrashLoadFailed')}
          </p>
          <Button
            color="neutral"
            variant="ghost"
            size="sm"
            loading={loadingMore}
            onClick={() => requestPage(null)}
          >
            {t('retry')}
          </Button>
        </div>
      )}
      {/* An empty bin is the good state, and there is nothing to do about it. */}
      {items !== null && items.length === 0 && <EmptyState title={t('teamTrashEmpty')} />}

      {/* The same row the folder list and the search results use: a kind icon,
          the name, where it came from, when it was thrown away. It was a stack
          of full-width cards with a name and a button — a third way of drawing
          a file, in the one place a person arrives at frightened. */}
      {items !== null && items.length > 0 && (
        <Table size="sm" className="team-explorer-rows team-trash-list" label={t('teamTrashTitle')}>
          <TableHeader>
            <TableHeaderCell className="team-trash-row-glyph" />
            <TableHeaderCell className="team-explorer-row-name">
              {t('teamExplorerSortName')}
            </TableHeaderCell>
            <TableHeaderCell className="team-explorer-row-date">
              {t('teamTrashOrigin')}
            </TableHeaderCell>
            <TableHeaderCell className="team-explorer-row-actions">
              <span className="visually-hidden">{t('teamAccountColumnActions')}</span>
            </TableHeaderCell>
          </TableHeader>
          {items.map(item => (
            <TableRow key={item.id} className={`team-explorer-row is-${item.kind}`}>
              <TableCell className="team-trash-row-glyph" aria-hidden="true">
                {/* The trash knows only file, folder or shortcut — the catalogue's
                    finer kinds are not carried across a deletion. */}
                <KindIcon kind={item.kind === 'file' ? 'other' : item.kind} />
              </TableCell>
              <TableCell className="team-explorer-row-name" title={item.name}>
                {item.name}
              </TableCell>
              <TableCell className="team-explorer-row-date" title={item.parentPathHint ?? ''}>
                {item.parentPathHint ?? formatDate(item.trashedAt, language)}
              </TableCell>
              <TableCell className="team-explorer-row-actions">
                {/* A word, not a bordered button on every row (024, benchmarked on
                    Drive's trash): the list is read as a list of files, and the
                    one thing to do to each is said quietly beside it. */}
                <Button
                  color="primary"
                  variant="ghost"
                  size="sm"
                  loading={restoringId === item.id}
                  onClick={() => void restore(item)}
                >
                  {t('teamFileRestore')}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </Table>
      )}

      {items !== null && items.length > 0 && !exhausted && (
        <Button
          color="neutral"
          variant="ghost"
          loading={loadingMore}
          onClick={() => requestPage(items.at(-1)?.trashedAt ?? null, items.at(-1)?.id ?? null)}
        >
          {t('teamTrashLoadMore')}
        </Button>
      )}
    </section>
  );
}
