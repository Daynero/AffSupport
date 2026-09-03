/**
 * The 2FA notebook (feature 016).
 *
 * A list of one-line rows: a name, the key behind a copy button, and a press
 * that turns the key into the six-digit code already sitting in the clipboard.
 * Deliberately small — a notebook, not a password manager.
 *
 * The one tool in the catalogue that asks the local app for nothing, which is
 * why the registry marks it `runtime: 'browser'` and why opening it while the
 * app is closed is not a state worth mentioning to anyone.
 */

import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { analytics } from '../analytics/service';
import { Button } from '../components/ui';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { ToastProvider } from '../components/toast';
import { useI18n } from '../i18n';
import type { TwoFactorEntry } from '../api/two-factor';
import { usePageEntrance } from '../lib/navigation';
import { measureClockSkew } from './clock-skew';
import { TwoFactorProvider, useTwoFactor } from './TwoFactorContext';
import { TwoFactorForm } from './TwoFactorForm';
import { TwoFactorRow } from './TwoFactorRow';

export default function TwoFactorPage() {
  return (
    <ToastProvider>
      <TwoFactorProvider>
        <TwoFactorNotebook />
      </TwoFactorProvider>
    </ToastProvider>
  );
}

function TwoFactorNotebook() {
  const { t } = useI18n();
  const entering = usePageEntrance();
  const { entries, status, errorCode, add } = useTwoFactor();
  const { edit } = useTwoFactor();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<TwoFactorEntry | null>(null);
  const [query, setQuery] = useState('');
  const [clockOffBy, setClockOffBy] = useState<number | null>(null);

  useEffect(() => {
    document.title = 'Soty — 2FA';
    analytics.track('tool_opened', { tool_identifier: 'two-factor' });
  }, []);

  // Asked once, when the tool opens. A clock does not drift within a session,
  // and a warning that appears mid-use would be more startling than useful.
  useEffect(() => {
    const controller = new AbortController();
    void measureClockSkew(controller.signal).then(skew => {
      if (skew?.warn) setClockOffBy(Math.round(Math.abs(skew.offsetMs) / 1000));
    });
    return () => controller.abort();
  }, []);

  /**
   * Both halves of the search the owner asked for: by name, and by the key
   * itself — paste a fragment of a seed to find out which account it belongs to.
   * It runs over the list already in memory, so it answers as fast as typing.
   */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return entries;
    return entries.filter(
      item => item.name.toLowerCase().includes(needle) || item.seed.toLowerCase().includes(needle)
    );
  }, [entries, query]);

  const formOpen = adding || editing !== null;
  const closeForm = () => {
    setAdding(false);
    setEditing(null);
  };

  return (
    // `.workspace`, like every other tool page — the compressor, the stitcher and
    // the transcription editor all use it, and a narrower container here made
    // this the one tool that looked like a settings page.
    <main className={entering ? 'workspace page-enter' : 'workspace'}>
      {clockOffBy !== null && (
        <p className="two-factor-clock-warning" role="status">
          {t('twoFactorClockOff', { seconds: clockOffBy })}
        </p>
      )}

      <div className="two-factor-toolbar">
        <input
          type="search"
          value={query}
          aria-label={t('twoFactorSearchLabel')}
          placeholder={t('twoFactorSearchLabel')}
          onChange={event => setQuery(event.target.value)}
        />
        <Button variant="primary" onClick={() => setAdding(true)}>
          <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          {t('twoFactorAdd')}
        </Button>
      </div>

      {formOpen && (
        <TwoFactorForm
          // Remounted per entry so the fields start from the right values
          // rather than being reset by an effect after the first paint.
          key={editing?.id ?? 'new'}
          editing={editing !== null}
          initialName={editing?.name ?? ''}
          onCancel={closeForm}
          onSubmit={async (name, seed) => {
            if (editing) {
              const failed = await edit(editing.id, name, seed);
              if (failed) return failed;
              closeForm();
              return null;
            }
            // Adding always carries a parsed key; `null` is the form's
            // rename-only case, which cannot arise here.
            const failure = await add(name, seed ?? '');
            if (failure) return failure;
            analytics.track('feature_enabled', {
              tool_identifier: 'two-factor',
              feature_identifier: 'entry_added'
            });
            closeForm();
            return null;
          }}
        />
      )}

      {status === 'loading' && (
        <div className="empty-state">
          <span>{t('twoFactorLoading')}</span>
        </div>
      )}
      {status === 'failed' && (
        <div className="empty-state two-factor-failed" role="alert">
          <strong>
            {errorCode === 'NOT_AUTHENTICATED'
              ? t('twoFactorLoadFailedSignedOut')
              : t('twoFactorLoadFailed')}
          </strong>
        </div>
      )}
      {status === 'ready' && entries.length === 0 && !formOpen && (
        <div className="empty-state">
          <strong>{t('twoFactorEmpty')}</strong>
          <span>{t('twoFactorEmptyBody')}</span>
        </div>
      )}
      {/* Distinct from the empty notebook on purpose: "you have nothing" and
          "you have things, none of them this" are different situations, and
          only one of them is solved by adding a key. */}
      {status === 'ready' && entries.length > 0 && visible.length === 0 && (
        <div className="empty-state">
          <strong>{t('twoFactorNoMatches', { query: query.trim() })}</strong>
          <span>{t('twoFactorNoMatchesBody')}</span>
        </div>
      )}
      {visible.length > 0 && (
        <ul className="two-factor-list" aria-label={t('twoFactorListLabel')}>
          {visible.map(entry => (
            <TwoFactorRow key={entry.id} entry={entry} onEdit={setEditing} />
          ))}
        </ul>
      )}
    </main>
  );
}
