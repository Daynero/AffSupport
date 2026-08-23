import { useCallback, useEffect, useState } from 'react';
import type { TeamTrashedMaterial } from '../../api/team';
import { teamApi } from '../../api/team';
import { Button } from '../../components/ui';
import { LabeledSkeleton } from '../../components/LabeledSkeleton';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';

export interface TrashViewClient {
  listTrashedMaterials: (input: {
    teamId: string;
    limit?: number;
    before?: string | null;
  }) => Promise<TeamTrashedMaterial[]>;
  restoreMaterial: (input: {
    teamId: string;
    materialId: string;
    idempotencyKey: string;
  }) => Promise<unknown>;
}

const defaultClient: TrashViewClient = teamApi;
const PAGE_SIZE = 50;

/**
 * What has been trashed, and the way back.
 *
 * Undo covers the seconds after a mistake; this covers the hours after it,
 * which is when most people notice (finding R2). Paged by the timestamp of the
 * last row rather than by offset, so restoring something mid-scroll cannot
 * shift the window and hide a neighbour.
 */
export function TrashView({
  teamId,
  client = defaultClient
}: {
  teamId: string;
  client?: TrashViewClient;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const [items, setItems] = useState<TeamTrashedMaterial[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = useCallback(
    async (before: string | null) => {
      const page = await client.listTrashedMaterials({ teamId, limit: PAGE_SIZE, before });
      if (page.length < PAGE_SIZE) setExhausted(true);
      setItems(current => (before === null ? page : [...(current ?? []), ...page]));
    },
    [client, teamId]
  );

  useEffect(() => {
    let active = true;
    setItems(null);
    setFailed(false);
    setExhausted(false);
    void load(null).catch(() => {
      if (active) setFailed(true);
    });
    return () => {
      active = false;
    };
  }, [load]);

  const restore = async (item: TeamTrashedMaterial) => {
    setRestoringId(item.id);
    try {
      await client.restoreMaterial({
        teamId,
        materialId: item.id,
        idempotencyKey: crypto.randomUUID()
      });
      setItems(current => (current ?? []).filter(row => row.id !== item.id));
      push({ tone: 'success', text: t('teamToastRestored') });
    } catch (cause) {
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <section className="team-panel team-trash-view" aria-labelledby="team-trash-title">
      <div className="team-panel-heading">
        <h2 id="team-trash-title">{t('teamTrashTitle')}</h2>
      </div>
      {/* Honest about what this is: Drive's own retention decides how long a
          trashed file can still be restored, and this view cannot change that. */}
      <p className="team-trash-note">{t('teamTrashRetentionNote')}</p>

      {items === null && !failed && <LabeledSkeleton label="teamTrashLoading" rows={3} />}
      {failed && (
        <p className="team-inline-error" role="alert">
          {t('teamTrashLoadFailed')}
        </p>
      )}
      {items !== null && items.length === 0 && <p>{t('teamTrashEmpty')}</p>}

      <ul className="team-trash-list">
        {(items ?? []).map(item => (
          <li key={item.id}>
            <div className="team-trash-identity">
              <strong>{item.name}</strong>
              {item.parentPathHint && <span>{item.parentPathHint}</span>}
            </div>
            <Button
              type="button"
              variant="secondary"
              loading={restoringId === item.id}
              onClick={() => void restore(item)}
            >
              {t('teamFileRestore')}
            </Button>
          </li>
        ))}
      </ul>

      {items !== null && items.length > 0 && !exhausted && (
        <Button
          type="button"
          variant="ghost"
          loading={loadingMore}
          onClick={() => {
            setLoadingMore(true);
            void load(items.at(-1)?.trashedAt ?? null)
              .catch(() => setFailed(true))
              .finally(() => setLoadingMore(false));
          }}
        >
          {t('teamTrashLoadMore')}
        </Button>
      )}
    </section>
  );
}
