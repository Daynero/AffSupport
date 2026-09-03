/**
 * 2FA Wallet (feature 016).
 *
 * A table of accounts: a name, and one button that turns the stored key into
 * the six digits already sitting on the clipboard. Above it, a bar for a key
 * that is not stored at all — paste it, take the code, store nothing.
 *
 * The only tool in the catalogue that asks the local app for nothing, which is
 * why the registry marks it `runtime: 'browser'`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Clipboard, Plus, Search, Shield, Trash2, Zap } from 'lucide-react';
import { analytics } from '../analytics/service';
import { IconButton } from '../components/ui';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { ToastProvider, useToasts } from '../components/toast';
import { useI18n, type TranslationKey } from '../i18n';
import { usePageEntrance } from '../lib/navigation';
import { currentBrowserPlatform } from '../lib/platform';
import { measureClockSkew } from './clock-skew';
import { QuickCode } from './QuickCode';
import { TwoFactorProvider, useTwoFactor } from './TwoFactorContext';
import { TwoFactorEditRow, TwoFactorRow } from './TwoFactorRow';

type SortOrder = 'az' | 'za' | 'newest' | 'oldest';

const SORT_LABELS: Record<SortOrder, TranslationKey> = {
  az: 'twoFactorSortAz',
  za: 'twoFactorSortZa',
  newest: 'twoFactorSortNewest',
  oldest: 'twoFactorSortOldest'
};

export default function TwoFactorPage() {
  return (
    <ToastProvider>
      <TwoFactorProvider>
        <TwoFactorWallet />
      </TwoFactorProvider>
    </ToastProvider>
  );
}

function TwoFactorWallet() {
  const { t } = useI18n();
  const { push } = useToasts();
  const entering = usePageEntrance();
  const { entries, status, errorCode, add, edit, remove } = useTwoFactor();

  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<SortOrder>('az');
  const [quickOpen, setQuickOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [clockOffBy, setClockOffBy] = useState<number | null>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'Soty — 2FA Wallet';
    analytics.track('tool_opened', { tool_identifier: 'two-factor' });
  }, []);

  // Asked once, when the tool opens: a clock does not drift within a session,
  // and a warning that appeared mid-use would startle more than it helps.
  useEffect(() => {
    const controller = new AbortController();
    void measureClockSkew(controller.signal).then(skew => {
      if (skew?.warn) setClockOffBy(Math.round(Math.abs(skew.offsetMs) / 1000));
    });
    return () => controller.abort();
  }, []);

  // ⌘K / Ctrl+K reaches the search field from anywhere on the page.
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k') return;
      if (!(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      search.current?.focus();
      search.current?.select();
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);

  /**
   * Both halves of the search: by name, and by the key itself — paste a
   * fragment of a key to find out which account it belongs to. It runs over the
   * list already in memory, so it answers as fast as typing.
   */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched =
      needle === ''
        ? entries
        : entries.filter(
            item =>
              item.name.toLowerCase().includes(needle) || item.seed.toLowerCase().includes(needle)
          );
    const sorted = [...matched];
    if (order === 'az') sorted.sort((a, b) => a.name.localeCompare(b.name));
    if (order === 'za') sorted.sort((a, b) => b.name.localeCompare(a.name));
    if (order === 'newest') sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (order === 'oldest') sorted.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return sorted;
  }, [entries, query, order]);

  const selectOne = useCallback((id: string, on: boolean) => {
    setSelected(current => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const allVisibleSelected = visible.length > 0 && visible.every(item => selected.has(item.id));

  const removeSelected = async () => {
    const doomed = visible.filter(item => selected.has(item.id));
    let failed = 0;
    for (const item of doomed) {
      if (await remove(item.id)) failed += 1;
    }
    setSelected(new Set());
    if (failed > 0) push({ tone: 'error', text: t('twoFactorDeleteFailed') });
  };

  /**
   * The second way in: a key already on the clipboard, straight into a draft row.
   * Reading the clipboard needs the browser's permission, and a refusal is an
   * ordinary answer here rather than an error worth dwelling on.
   */
  const pasteFromClipboard = async () => {
    let text = '';
    try {
      text = (await navigator.clipboard.readText()).trim();
    } catch {
      push({ tone: 'error', text: t('twoFactorClipboardBlocked') });
      return;
    }
    if (text === '') return;
    setEditingId(null);
    setAdding(true);
    // The draft row mounts on the next paint; fill its key field once it exists.
    window.setTimeout(() => {
      const field = document.querySelector<HTMLInputElement>(
        '.tfa-row.is-editing .tfa-cell-live input'
      );
      if (!field) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(field, text);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }, 0);
  };

  const shortcutHint = currentBrowserPlatform() === 'macos' ? '⌘K' : 'Ctrl K';

  return (
    <main className={entering ? 'tfa-page page-enter' : 'tfa-page'}>
      <header className="tfa-header">
        <div className="tfa-brand">
          <span className="tfa-brand-mark" aria-hidden="true">
            <Shield size={18} strokeWidth={ICON_STROKE} />
          </span>
          <span className="tfa-brand-name">2FA Wallet</span>
        </div>

        <div className="tfa-search">
          <Search size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <input
            ref={search}
            type="search"
            value={query}
            aria-label={t('twoFactorSearchLabel')}
            placeholder={t('twoFactorSearchPlaceholder')}
            onChange={event => setQuery(event.target.value)}
          />
          <kbd aria-hidden="true">{shortcutHint}</kbd>
        </div>

        <div className="tfa-header-actions">
          <button
            type="button"
            className={quickOpen ? 'tfa-quick-toggle is-on' : 'tfa-quick-toggle'}
            aria-pressed={quickOpen}
            onClick={() => setQuickOpen(open => !open)}
          >
            <Zap size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('twoFactorQuickCode')}
          </button>

          <SortMenu order={order} onChange={setOrder} />

          <div className="tfa-add">
            <button
              type="button"
              className="tfa-add-main"
              onClick={() => {
                setEditingId(null);
                setAdding(true);
              }}
            >
              <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              {t('twoFactorAdd')}
            </button>
            <AddMenu onPaste={() => void pasteFromClipboard()} />
          </div>
        </div>
      </header>

      {clockOffBy !== null && (
        <p className="tfa-clock-warning" role="status">
          {t('twoFactorClockOff', { seconds: clockOffBy })}
        </p>
      )}

      {quickOpen && <QuickCode onClose={() => setQuickOpen(false)} />}

      <div className="tfa-table-frame">
        <table className="tfa-table">
          <caption className="visually-hidden">{t('twoFactorListLabel')}</caption>
          <thead>
            <tr>
              <th scope="col" className="tfa-cell-check">
                <input
                  type="checkbox"
                  className="tfa-check"
                  checked={allVisibleSelected}
                  aria-label={t('twoFactorSelectAll')}
                  onChange={event =>
                    setSelected(
                      event.target.checked ? new Set(visible.map(item => item.id)) : new Set()
                    )
                  }
                />
              </th>
              <th scope="col" className="tfa-cell-name">
                {t('twoFactorColumnAccount')}
              </th>
              <th scope="col" className="tfa-cell-live">
                {selected.size > 0 && (
                  <button
                    type="button"
                    className="tfa-bulk-delete"
                    onClick={() => void removeSelected()}
                  >
                    <Trash2 size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
                    {t('twoFactorDeleteSelected', { count: selected.size })}
                  </button>
                )}
              </th>
              <th scope="col" className="tfa-cell-actions">
                {t('twoFactorColumnActions')}
              </th>
            </tr>
          </thead>
          <tbody>
            {adding && (
              <TwoFactorEditRow
                requireSeed
                onCancel={() => setAdding(false)}
                onSave={async (name, seed) => {
                  const failure = await add(name, seed ?? '');
                  if (failure) return failure;
                  analytics.track('feature_enabled', {
                    tool_identifier: 'two-factor',
                    feature_identifier: 'entry_added'
                  });
                  setAdding(false);
                  return null;
                }}
              />
            )}

            {visible.map(entry =>
              editingId === entry.id ? (
                <TwoFactorEditRow
                  key={entry.id}
                  initialName={entry.name}
                  requireSeed={false}
                  onCancel={() => setEditingId(null)}
                  onSave={async (name, seed) => {
                    const failure = await edit(entry.id, name, seed);
                    if (failure) return failure;
                    setEditingId(null);
                    return null;
                  }}
                />
              ) : (
                <TwoFactorRow
                  key={entry.id}
                  entry={entry}
                  selected={selected.has(entry.id)}
                  onSelectedChange={on => selectOne(entry.id, on)}
                  onEdit={() => {
                    setAdding(false);
                    setEditingId(entry.id);
                  }}
                  onDelete={() => remove(entry.id)}
                />
              )
            )}
          </tbody>
        </table>

        {status === 'loading' && <p className="tfa-notice">{t('twoFactorLoading')}</p>}
        {status === 'failed' && (
          <p className="tfa-notice tfa-notice-error" role="alert">
            {errorCode === 'NOT_AUTHENTICATED'
              ? t('twoFactorLoadFailedSignedOut')
              : t('twoFactorLoadFailed')}
          </p>
        )}
        {status === 'ready' && entries.length === 0 && !adding && (
          <p className="tfa-notice">
            <strong>{t('twoFactorEmpty')}</strong>
            <span>{t('twoFactorEmptyBody')}</span>
          </p>
        )}
        {/* Distinct from the empty notebook on purpose: "you have nothing" and
            "you have things, none of them this" are different situations, and
            only one is solved by adding a key. */}
        {status === 'ready' && entries.length > 0 && visible.length === 0 && (
          <p className="tfa-notice">
            <strong>{t('twoFactorNoMatches', { query: query.trim() })}</strong>
            <span>{t('twoFactorNoMatchesBody')}</span>
          </p>
        )}
      </div>
    </main>
  );
}

function SortMenu({ order, onChange }: { order: SortOrder; onChange: (order: SortOrder) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  return (
    <div className="tfa-menu-anchor" ref={anchor}>
      <button
        type="button"
        className="tfa-sort"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        {t('twoFactorSort', { order: t(SORT_LABELS[order]) })}
        <ChevronDown size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </button>
      {open && (
        <div className="tfa-menu" role="menu">
          {(Object.keys(SORT_LABELS) as SortOrder[]).map(value => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={order === value}
              onClick={() => {
                onChange(value);
                setOpen(false);
              }}
            >
              {t(SORT_LABELS[value])}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AddMenu({ onPaste }: { onPaste: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  return (
    <div className="tfa-menu-anchor" ref={anchor}>
      <IconButton
        label={t('twoFactorAddOptions')}
        className="tfa-add-more"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <ChevronDown size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
      {open && (
        <div className="tfa-menu tfa-menu-right" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onPaste();
            }}
          >
            <Clipboard size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />
            {t('twoFactorAddFromClipboard')}
          </button>
        </div>
      )}
    </div>
  );
}
