import { useId, useRef, useState } from 'react';
import { Check, Pencil, Settings2, Trash2, X } from 'lucide-react';
import { launchApi, type LaunchDictionaryItem } from '../../api/launches';
import { Button, IconButton, Input, Modal, Select } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { launchMutation } from './analytics';

type Kind = 'offers' | 'buyers';
type Operation = 'rename' | 'archive' | 'restore';
export function LaunchDictionaryManager({
  teamId,
  kind,
  items,
  selected,
  disabled,
  onChanged,
  onBusyChange
}: {
  teamId: string;
  kind: Kind;
  items: LaunchDictionaryItem[];
  selected: string;
  disabled: boolean;
  onChanged: (removedId?: string, replacement?: string) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const title = t(kind === 'offers' ? 'launchesManageOffers' : 'launchesManageBuyers');
  const heading = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [edit, setEdit] = useState<{ row: LaunchDictionaryItem; value: string } | null>(null);
  const [removing, setRemoving] = useState<LaunchDictionaryItem | null>(null);
  const [replacement, setReplacement] = useState('');
  const [deleted, setDeleted] = useState<LaunchDictionaryItem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Retain the exact request after an uncertain response so retry cannot duplicate it.
  const pending = useRef<{
    row: LaunchDictionaryItem;
    operation: Operation;
    value: string;
    key: string;
    replacement: string;
  } | null>(null);
  const run = async (row: LaunchDictionaryItem, operation: Operation, value = '') => {
    if (busy || disabled) return;
    const request = pending.current ?? {
      row,
      operation,
      value,
      key: crypto.randomUUID(),
      replacement
    };
    pending.current = request;
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    try {
      const result = await launchMutation(
        { flowId: request.key },
        `${request.operation}_dictionary`,
        () =>
          launchApi.editDictionary(
            teamId,
            kind,
            request.row,
            request.operation,
            request.value,
            request.key
          )
      );
      await onChanged(
        request.operation === 'archive' ? request.row.id : undefined,
        request.replacement
      );
      if (request.operation === 'archive')
        setDeleted(old => [...old.filter(x => x.id !== result.id), result]);
      if (request.operation === 'restore') setDeleted(old => old.filter(x => x.id !== result.id));
      setEdit(null);
      setRemoving(null);
      setReplacement('');
      pending.current = null;
    } catch (e) {
      setError(teamErrorMessageFor(e, t));
      if (e && typeof e === 'object' && 'retryable' in e && !e.retryable) {
        pending.current = null;
        if ('code' in e && e.code === 'LAUNCH_VERSION_CONFLICT') {
          setEdit(null);
          setRemoving(null);
          try {
            await onChanged();
          } catch {
            /* Keep the visible conflict; reopening can reload. */
          }
        }
      }
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };
  const icon = { size: ICON_SIZE, strokeWidth: ICON_STROKE, 'aria-hidden': true as const };
  return (
    <>
      <IconButton label={title} disabled={disabled} onClick={() => setOpen(true)}>
        <Settings2 {...icon} />
      </IconButton>
      {open && (
        <Modal
          nested
          size="md"
          labelledBy={heading}
          busy={busy}
          onClose={() => {
            if (!busy && !pending.current) setOpen(false);
          }}
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <h2 id={heading}>{title}</h2>
              <IconButton
                label={t('teamCancel')}
                title=""
                disabled={busy || !!pending.current}
                onClick={() => setOpen(false)}
              >
                <X {...icon} />
              </IconButton>
            </div>
            <Input
              aria-label={t('launchesSearch')}
              placeholder={t('launchesSearch')}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {error && <div role="alert">{error}</div>}
            {pending.current && !busy && (
              <Button onClick={() => void run(pending.current!.row, pending.current!.operation)}>
                {t('teamOperationRetry')}
              </Button>
            )}
            <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
              {items
                .filter(row => row.value.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
                .map(row => (
                  <div
                    key={row.id}
                    className="flex flex-col gap-2 rounded-control border border-neutral-border p-2"
                  >
                    <div className="flex items-center gap-2">
                      {edit?.row.id === row.id ? (
                        <>
                          <Input
                            aria-label={t('teamRenameTitle')}
                            value={edit.value}
                            disabled={busy || !!pending.current}
                            onChange={e => setEdit({ ...edit, value: e.target.value })}
                          />
                          <IconButton
                            label={t('teamRenameSave')}
                            title=""
                            disabled={busy || !!pending.current || !edit.value.trim()}
                            onClick={() => void run(edit.row, 'rename', edit.value)}
                          >
                            <Check {...icon} />
                          </IconButton>
                          <IconButton
                            label={t('teamCancel')}
                            title=""
                            disabled={busy || !!pending.current}
                            onClick={() => setEdit(null)}
                          >
                            <X {...icon} />
                          </IconButton>
                        </>
                      ) : (
                        <>
                          <span className="min-w-0 flex-1 break-words">{row.value}</span>
                          <IconButton
                            label={t('teamFileRename')}
                            title=""
                            disabled={busy || !!pending.current}
                            onClick={() => {
                              setEdit({ row, value: row.value });
                              setRemoving(null);
                            }}
                          >
                            <Pencil {...icon} />
                          </IconButton>
                          <IconButton
                            label={t('launchesArchiveShort')}
                            title=""
                            disabled={busy || !!pending.current}
                            onClick={() => {
                              setRemoving(row);
                              setReplacement('');
                              setEdit(null);
                            }}
                          >
                            <Trash2 {...icon} />
                          </IconButton>
                        </>
                      )}
                    </div>
                    {removing?.id === row.id && (
                      <div className="flex flex-col gap-2">
                        {selected === row.id && (
                          <>
                            <span>{t('launchesDictionaryReplacement')}</span>
                            <Select
                              aria-label={t('launchesDictionaryReplacement')}
                              value={replacement}
                              options={items
                                .filter(x => x.id !== row.id)
                                .map(x => ({ value: x.id, label: x.value }))}
                              onChange={setReplacement}
                              disabled={busy}
                            />
                          </>
                        )}
                        <div className="flex gap-2">
                          <Button
                            variant="danger"
                            disabled={
                              busy || !!pending.current || (selected === row.id && !replacement)
                            }
                            onClick={() => void run(removing, 'archive')}
                          >
                            {t('launchesArchiveShort')}
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy || !!pending.current}
                            onClick={() => setRemoving(null)}
                          >
                            {t('teamCancel')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
            </div>
            {deleted.map(row => (
              <div key={row.id} className="flex items-center justify-between gap-2">
                <span>{row.value}</span>
                <Button
                  variant="ghost"
                  disabled={busy || !!pending.current}
                  onClick={() => void run(row, 'restore')}
                >
                  {t('teamUndo')}
                </Button>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
