import { useEffect, useRef, useState } from 'react';
import { Settings2 } from 'lucide-react';
import { Button, Checkbox, ErrorState, LoadingState } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { teamErrorMessageFor } from '../errors';
import { beginCatalogUiFlow, type CatalogUiFlow } from './analytics';
import { SettingsSection } from '../workspace/SettingsSection';

export interface CatalogDefaultsClient {
  getCatalogUpdaterRestitchDefault?: (teamId: string) => Promise<boolean>;
  setCatalogUpdaterRestitch?: (teamId: string, value: boolean) => Promise<unknown>;
  getCatalogUpdaterRandomLinkVariation?: (teamId: string) => Promise<boolean>;
  setCatalogUpdaterRandomLinkVariation?: (teamId: string, value: boolean) => Promise<boolean>;
  getCatalogUpdaterRefreshImages?: (teamId: string) => Promise<boolean>;
  setCatalogUpdaterRefreshImages?: (teamId: string, value: boolean) => Promise<boolean>;
  getCatalogUpdaterRefreshTexts?: (teamId: string) => Promise<boolean>;
  setCatalogUpdaterRefreshTexts?: (teamId: string, value: boolean) => Promise<boolean>;
  getCatalogUpdaterGrow?: (teamId: string) => Promise<boolean>;
  setCatalogUpdaterGrow?: (teamId: string, value: boolean) => Promise<boolean>;
}

const FIELDS = [
  [
    'restitch',
    'getCatalogUpdaterRestitchDefault',
    'setCatalogUpdaterRestitch',
    'catalogUpdaterRestitch',
    'catalogUpdaterRestitchEffect'
  ],
  [
    'randomLinkVariation',
    'getCatalogUpdaterRandomLinkVariation',
    'setCatalogUpdaterRandomLinkVariation',
    'catalogRandomLinkVariation',
    'catalogUpdaterLinkVariationEffect'
  ],
  [
    'refreshImages',
    'getCatalogUpdaterRefreshImages',
    'setCatalogUpdaterRefreshImages',
    'catalogUpdaterRefreshImages',
    'catalogUpdaterImagesEffect'
  ],
  [
    'refreshTexts',
    'getCatalogUpdaterRefreshTexts',
    'setCatalogUpdaterRefreshTexts',
    'catalogUpdaterRefreshTexts',
    'catalogUpdaterTextsEffect'
  ],
  [
    'growProducts',
    'getCatalogUpdaterGrow',
    'setCatalogUpdaterGrow',
    'catalogUpdaterGrow',
    'catalogUpdaterGrowEffect'
  ]
] as const;
type Defaults = Record<(typeof FIELDS)[number][0], boolean>;

/** Space-level defaults are a draft until Save. No registry/profile mutation is used here. */
export function CatalogDefaultsEditor({
  teamId,
  client,
  onDraftChange
}: {
  teamId: string;
  client: CatalogDefaultsClient;
  onDraftChange?: (state: { dirty: boolean; saving: boolean }) => void;
}) {
  const { t } = useI18n();
  const { can } = useTeam();
  const editable = can('process');
  const supported = FIELDS.every(([, get]) => Boolean(client[get]));
  const [saved, setSaved] = useState<Defaults | null>(null);
  const [draft, setDraft] = useState<Defaults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [revision, setRevision] = useState(0);
  const flow = useRef<CatalogUiFlow | null>(null);
  useEffect(() => {
    if (confirmed) flow.current?.complete();
  }, [confirmed]);
  useEffect(
    () => () => {
      flow.current?.cancel();
    },
    []
  );

  useEffect(() => {
    if (!supported) return;
    let active = true;
    flow.current?.cancel();
    flow.current = beginCatalogUiFlow('template');
    setSaved(null);
    setDraft(null);
    setError(null);
    void Promise.all(
      FIELDS.map(async ([field, get]) => [field, await client[get]!(teamId)] as const)
    )
      .then(values => {
        if (!active) return;
        const loaded = Object.fromEntries(values) as Defaults;
        setSaved(loaded);
        setDraft(loaded);
      })
      .catch(cause => {
        if (active) {
          setError(teamErrorMessageFor(cause, t));
          flow.current?.fail('READ_FAILED');
        }
      });
    return () => {
      active = false;
    };
  }, [client, teamId, supported, revision, t]);

  const changed = FIELDS.filter(([field]) => saved && draft && saved[field] !== draft[field]);
  const dirty = changed.length > 0;
  useEffect(() => {
    onDraftChange?.({ dirty, saving });
  }, [dirty, saving, onDraftChange]);
  useEffect(
    () => () => {
      onDraftChange?.({ dirty: false, saving: false });
    },
    [onDraftChange]
  );
  useEffect(() => {
    if (!dirty && !saving) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, saving]);
  if (!supported) return null;
  const save = async () => {
    if (!draft || !saved || saving || !editable || !changed.length) return;
    flow.current?.cancel();
    flow.current = beginCatalogUiFlow('template');
    flow.current.stage('save_requested');
    setSaving(true);
    setConfirmed(false);
    setError(null);
    // The legacy defaults have separate RPCs. Keep every confirmed success so a partial
    // failure remains a retryable draft instead of reporting an all-or-nothing success.
    const results = await Promise.allSettled(
      changed.map(async ([field, get, set]) => {
        if (!client[set]) throw new Error('Defaults setting unavailable');
        await client[set]!(teamId, draft[field]);
        if ((await client[get]!(teamId)) !== draft[field])
          throw new Error('Defaults save unconfirmed');
        return field;
      })
    );
    const next = { ...saved };
    let failure: unknown;
    for (const result of results) {
      if (result.status === 'fulfilled') next[result.value] = draft[result.value];
      else failure = result.reason;
    }
    setSaved(next);
    if (results.some(result => result.status === 'rejected')) {
      setError(teamErrorMessageFor(failure, t));
      flow.current.fail('SAVE_FAILED');
    } else {
      flow.current.stage('save_confirmed');
      setConfirmed(true);
    }
    setSaving(false);
  };

  return (
    <SettingsSection
      icon={Settings2}
      titleId="catalog-defaults-title"
      title={t('catalogUpdaterDefaultsTitle')}
      description={t('catalogUpdaterDefaultsScope')}
    >
      {!draft && !error && <LoadingState count={2} label={t('catalogUpdaterDefaultsTitle')} />}
      {error && (
        <ErrorState
          message={error}
          onRetry={() => (draft ? void save() : setRevision(value => value + 1))}
          retryLabel={t('catalogUpdaterRetry')}
        />
      )}
      {draft && (
        <form
          className="team-dialog-form"
          onSubmit={event => {
            event.preventDefault();
            void save();
          }}
        >
          {FIELDS.map(([field, , set, label, hint]) => (
            <div key={field} className="field-group">
              <Checkbox
                checked={draft[field]}
                disabled={!editable || !client[set] || saving}
                label={t(label)}
                onChange={checked => {
                  setDraft({ ...draft, [field]: checked });
                  setConfirmed(false);
                  flow.current?.stage('draft_changed');
                }}
              />
              <details>
                <summary>{t('showDetails')}</summary>
                <p className="field-hint">{t(hint)}</p>
              </details>
            </div>
          ))}
          {editable && (
            <div className="settings-section-actions">
              <Button type="submit" color="success" loading={saving} disabled={!changed.length}>
                {t('catalogUpdaterSaveProfile')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={!changed.length || saving}
                onClick={() => {
                  flow.current?.cancel();
                  setDraft(saved);
                  setError(null);
                  setConfirmed(false);
                  flow.current?.stage('draft_changed');
                }}
              >
                {t('teamCancel')}
              </Button>
            </div>
          )}
          {confirmed && <p role="status">{t('catalogUpdaterDefaultsSaved')}</p>}
        </form>
      )}
    </SettingsSection>
  );
}
