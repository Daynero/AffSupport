import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { TeamAccountEntityKind } from '@video-compressor/shared';
import {
  Button,
  Drawer,
  ErrorState,
  LoadingState,
  SearchField,
  EmptyState,
  IconButton,
  DropdownMenu,
  ConfirmDialog
} from '../../components/ui/index';
import { accountsWorkspaceApi, type ArchivedAccountItem } from '../../api/team-accounts-workspace';
import { useI18n } from '../../i18n';
import { accountFlowId, emitAccountSignal } from './analytics';
import { teamErrorMessageFor } from '../errors';

export function ArchivedAccountActions({
  row,
  busy,
  onRestore,
  onDelete
}: {
  row: ArchivedAccountItem;
  busy: boolean;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  return (
    <span ref={anchor}>
      <IconButton
        label={`${t('teamAccountColumnActions')}: ${row.name}`}
        title=""
        variant="ghost"
        disabled={busy}
        onClick={() => setOpen(true)}
      >
        <MoreHorizontal />
      </IconButton>
      <DropdownMenu
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        label={t('teamAccountColumnActions')}
        items={[
          {
            id: 'restore',
            label: t('accountsRestore'),
            disabled: busy || !row.canRestore,
            onSelect: onRestore
          },
          {
            id: 'delete',
            label: t(row.entityKind === 'agent' ? 'teamAgentDelete' : 'teamAccountDeleteConfirm'),
            disabled: busy,
            onSelect: onDelete
          }
        ]}
      />
    </span>
  );
}
export function AccountArchiveDrawer({
  teamId,
  canEdit,
  onClose,
  onDelete,
  onRestore
}: {
  teamId: string;
  canEdit: boolean;
  onClose: () => void;
  onDelete: (kind: TeamAccountEntityKind, id: string) => Promise<void>;
  onRestore: () => Promise<void>;
}) {
  const { t, language } = useI18n();
  const [rows, setRows] = useState<ArchivedAccountItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState<ArchivedAccountItem | null>(null);
  const deleted = useRef<{
    flowId: string;
    operation: 'deleteAccount' | 'deleteAccountAgent';
    query: string;
    id: string;
    teamId: string;
  } | null>(null);
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
    setConfirming(null);
  }, [teamId, canEdit]);
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
    const proof = deleted.current;
    if (
      !proof ||
      loading ||
      failed ||
      proof.teamId !== teamId ||
      proof.query !== query ||
      rows.some(row => row.id === proof.id)
    )
      return;
    deleted.current = null;
    emitAccountSignal('retained_action', 'applied', {
      flowId: proof.flowId,
      operation: proof.operation,
      outcome: 'success',
      result: 'complete'
    });
  }, [rows, teamId, loading, failed, query]);
  const remove = async (row: ArchivedAccountItem) => {
    if (pending || !canEdit) return;
    setPending(row.id);
    const flowId = accountFlowId();
    const operation = row.entityKind === 'agent' ? 'deleteAccountAgent' : 'deleteAccount';
    let accepted = false;
    emitAccountSignal('retained_action', 'requested', { flowId, operation });
    try {
      await onDelete(row.entityKind, row.id);
      accepted = true;
      emitAccountSignal('retained_action', 'accepted', { flowId, operation, outcome: 'success' });
      if (!lifetime.current.active || lifetime.current.teamId !== teamId) return;
      deleted.current = { flowId, operation, id: row.id, teamId, query };
      setConfirming(null);
      await onRestore();
      if (lifetime.current.active && lifetime.current.teamId === teamId) setNonce(n => n + 1);
    } catch (cause) {
      emitAccountSignal('retained_action', 'terminal', {
        flowId,
        operation,
        outcome: 'failure',
        result: accepted ? 'unknown' : 'failed',
        code: cause && typeof cause === 'object' && 'code' in cause ? cause.code : 'UNKNOWN'
      });
      if (lifetime.current.active && lifetime.current.teamId === teamId)
        setError(teamErrorMessageFor(cause, t));
    } finally {
      if (lifetime.current.active && lifetime.current.teamId === teamId) setPending(null);
    }
  };
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
                <ArchivedAccountActions
                  row={row}
                  busy={pending !== null}
                  onRestore={() => void restore(row.entityKind, row.id)}
                  onDelete={() => {
                    setError('');
                    setConfirming(row);
                  }}
                />
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
      {confirming && canEdit && (
        <ConfirmDialog
          nested
          initialFocus="cancel"
          busy={pending !== null}
          title={t(
            confirming.entityKind === 'agent' ? 'teamAgentDeleteTitle' : 'teamAccountDeleteTitle',
            { tag: confirming.name, name: confirming.name }
          )}
          body={t(
            confirming.entityKind === 'agent'
              ? 'accountsDeleteAgentWarning'
              : 'accountsDeleteSocialWarning'
          )}
          confirmLabel={t(
            confirming.entityKind === 'agent' ? 'teamAgentDelete' : 'teamAccountDeleteConfirm'
          )}
          cancelLabel={t('teamCancel')}
          holdHint={t('accountsDeleteHoldHint')}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void remove(confirming)}
        />
      )}
    </Drawer>
  );
}
