import { useEffect, useRef, useState } from 'react';
import type { TeamAccountEntityKind } from '@video-compressor/shared';
import {
  Button,
  Drawer,
  ErrorState,
  LoadingState,
  SearchField,
  EmptyState
} from '../../components/ui/index';
import { accountsWorkspaceApi, type ArchivedAccountItem } from '../../api/team-accounts-workspace';
import { useI18n } from '../../i18n';
import { accountFlowId, emitAccountSignal } from './analytics';
export function AccountArchiveDrawer({
  teamId,
  canEdit,
  onClose,
  onRestore
}: {
  teamId: string;
  canEdit: boolean;
  onClose: () => void;
  onRestore: () => Promise<void>;
}) {
  const { t, language } = useI18n();
  const [rows, setRows] = useState<ArchivedAccountItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  const [next, setNext] = useState<string | null>(null);
  const restored = useRef<{ flowId: string; id: string; teamId: string; query: string } | null>(
    null
  );
  const lifetime = useRef({ active: true, teamId, canEdit, query });
  lifetime.current.teamId = teamId;
  lifetime.current.canEdit = canEdit;
  lifetime.current.query = query;
  useEffect(() => {
    lifetime.current.active = true;
    return () => {
      lifetime.current.active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    const timer = setTimeout(() => {
      void accountsWorkspaceApi
        .listArchive(teamId, query)
        .then(result => {
          if (active) {
            setRows(result.items);
            setNext(result.next);
          }
        })
        .catch(() => {
          if (active) setFailed(true);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 150);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [teamId, nonce, query]);
  useEffect(() => {
    const proof = restored.current;
    if (
      !proof ||
      loading ||
      failed ||
      proof.teamId !== teamId ||
      proof.query !== query ||
      rows.some(row => row.id === proof.id)
    )
      return;
    restored.current = null;
    emitAccountSignal('lifecycle', 'applied', {
      flowId: proof.flowId,
      outcome: 'success',
      result: 'restored',
      coverage: 'accounts_only'
    });
  }, [rows, loading, failed, teamId, query]);
  const archived = rows;
  const restore = async (kind: TeamAccountEntityKind, id: string) => {
    const current = () =>
      lifetime.current.active && lifetime.current.teamId === teamId && lifetime.current.canEdit;
    if (!current()) return;
    setPending(id);
    setError('');
    const flowId = accountFlowId();
    let accepted = false;
    try {
      emitAccountSignal('lifecycle', 'preflight', {
        flowId,
        entity: kind === 'agent' ? 'rk' : 'social'
      });
      const before = await accountsWorkspaceApi.preflight(teamId, kind, id);
      if (!current()) return;
      emitAccountSignal('lifecycle', 'requested', {
        flowId,
        entity: kind === 'agent' ? 'rk' : 'social'
      });
      await accountsWorkspaceApi.archive(
        teamId,
        kind,
        id,
        false,
        before.lifecycleVersion,
        before.token,
        crypto.randomUUID()
      );
      if (!current()) return;
      accepted = true;
      emitAccountSignal('lifecycle', 'accepted', {
        flowId,
        outcome: 'success',
        result: 'restored'
      });
      await onRestore();
      if (!current()) return;
      restored.current = { flowId, id, teamId, query };
      setNonce(n => n + 1);
    } catch (cause) {
      if (!current()) return;
      emitAccountSignal('lifecycle', 'terminal', {
        flowId,
        outcome: 'failure',
        result: accepted ? 'unknown' : 'failed',
        code: cause instanceof Error ? cause.message : 'UNKNOWN'
      });
      setError(
        cause instanceof Error && cause.message.includes('PARENT_ARCHIVED')
          ? t('accountsParentArchived')
          : t('accountsArchiveFailed')
      );
    } finally {
      if (lifetime.current.active && lifetime.current.teamId === teamId) setPending(null);
    }
  };
  return (
    <Drawer open title={t('accountsArchiveTitle')} onClose={onClose} side="right" size="lg">
      <SearchField
        aria-label={t('accountsArchiveSearch')}
        placeholder={t('accountsArchiveSearch')}
        value={query}
        onChange={setQuery}
      />
      {loading ? (
        <LoadingState label={t('teamAccountsLoading')} />
      ) : failed ? (
        <ErrorState
          message={t('teamAccountsLoadFailed')}
          retryLabel={t('retry')}
          onRetry={() => setNonce(n => n + 1)}
        />
      ) : archived.length === 0 ? (
        <EmptyState title={t('accountsArchiveEmpty')} />
      ) : (
        <div className="account-archive-list">
          {archived.map(row => (
            <div key={row.id} className="account-archive-row">
              <div>
                <strong>{row.name}</strong>
                <p className="text-label text-ink-muted">
                  {row.archivedAt
                    ? t('accountsArchiveDate', {
                        date: new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-GB', {
                          dateStyle: 'medium'
                        }).format(new Date(row.archivedAt))
                      })
                    : t('accountsArchived')}
                </p>
                {row.parentArchived && (
                  <p className="text-label text-ink-muted">{t('accountsParentArchived')}</p>
                )}
              </div>
              {canEdit && (
                <Button
                  size="sm"
                  variant="soft"
                  disabled={pending !== null || !row.canRestore}
                  loading={pending === row.id}
                  onClick={() => void restore(row.entityKind, row.id)}
                  aria-label={t('accountsRestoreAction', { name: row.name })}
                >
                  {t('accountsRestore')}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {next && !loading && (
        <Button
          onClick={() => {
            const current = () =>
              lifetime.current.active &&
              lifetime.current.teamId === teamId &&
              lifetime.current.query === query;
            setLoading(true);
            void accountsWorkspaceApi
              .listArchive(teamId, query, next)
              .then(result => {
                if (!current()) return;
                setRows(current => [...current, ...result.items]);
                setNext(result.next);
              })
              .catch(() => {
                if (current()) setFailed(true);
              })
              .finally(() => {
                if (current()) setLoading(false);
              });
          }}
        >
          {t('next')}
        </Button>
      )}
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </Drawer>
  );
}
