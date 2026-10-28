import { useEffect, useRef, useState } from 'react';
import { CircleHelp, Settings2 } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import './catalog-defaults.css';
import {
  Accordion,
  Button,
  Checkbox,
  ErrorState,
  IconButton,
  LoadingState,
  Popover
} from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { useTeam } from '../TeamContext';
import { teamErrorMessageFor } from '../errors';
import { beginCatalogUiFlow, type CatalogUiFlow } from './analytics';

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
    'catalogDefaultsRestitchAction',
    'catalogUpdaterRestitchEffect'
  ],
  [
    'randomLinkVariation',
    'getCatalogUpdaterRandomLinkVariation',
    'setCatalogUpdaterRandomLinkVariation',
    'catalogDefaultsLinksAction',
    'catalogUpdaterLinkVariationEffect'
  ],
  [
    'refreshImages',
    'getCatalogUpdaterRefreshImages',
    'setCatalogUpdaterRefreshImages',
    'catalogDefaultsImagesAction',
    'catalogUpdaterImagesEffect'
  ],
  [
    'refreshTexts',
    'getCatalogUpdaterRefreshTexts',
    'setCatalogUpdaterRefreshTexts',
    'catalogDefaultsTextsAction',
    'catalogUpdaterTextsEffect'
  ],
  [
    'growProducts',
    'getCatalogUpdaterGrow',
    'setCatalogUpdaterGrow',
    'catalogDefaultsGrowAction',
    'catalogUpdaterGrowEffect'
  ]
] as const;
type Defaults = Record<(typeof FIELDS)[number][0], boolean>;

/** Space-level defaults are a draft until Save. No registry/profile mutation is used here. */
export function CatalogDefaultsEditor({
  teamId,
  client,
  onDraftChange,
  open: controlledOpen,
  onOpenChange
}: {
  teamId: string;
  client: CatalogDefaultsClient;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
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
  const [readVisibleAttempt, setReadVisibleAttempt] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const [fieldResults, setFieldResults] = useState<
    Partial<Record<keyof Defaults, 'saved' | 'failed'>>
  >({});
  const flow = useRef<CatalogUiFlow | null>(null);
  useEffect(() => {
    if (readVisibleAttempt && flow.current?.id === readVisibleAttempt) flow.current.complete();
  }, [readVisibleAttempt]);
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
    const readFlow = flow.current;
    readFlow.stage('readback_requested');
    setSaved(null);
    setDraft(null);
    setError(null);
    setFieldResults({});
    setConfirmed(false);
    void Promise.all(
      FIELDS.map(async ([field, get]) => [field, await client[get]!(teamId)] as const)
    )
      .then(values => {
        if (!active) return;
        const loaded = Object.fromEntries(values) as Defaults;
        setSaved(loaded);
        setDraft(loaded);
        setReadVisibleAttempt(readFlow.id);
      })
      .catch(cause => {
        if (active) {
          setError(teamErrorMessageFor(cause, t));
          readFlow.fail('READ_FAILED');
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
    const statuses: typeof fieldResults = {};
    results.forEach((result, index) => {
      const field = changed[index][0];
      if (result.status === 'fulfilled') {
        next[result.value] = draft[result.value];
        statuses[field] = 'saved';
      } else {
        failure = result.reason;
        statuses[field] = 'failed';
      }
    });
    setFieldResults(current => ({ ...current, ...statuses }));
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
    <section className="catalog-defaults" aria-label={t('catalogDefaultsRulesTitle')}>
      <Accordion
        openIds={new Set(open ? ['catalog-default-rules'] : [])}
        onToggle={() => {
          setLocalOpen(!open);
          onOpenChange?.(!open);
        }}
        items={[
          {
            id: 'catalog-default-rules',
            title: t('catalogDefaultsRulesTitle'),
            icon: <Settings2 size={ICON_SIZE} strokeWidth={ICON_STROKE} />,
            aside: (
              <span className="catalog-defaults-summary">
                {saved &&
                  t('catalogDefaultsEnabled', {
                    count: FIELDS.filter(([field]) => saved[field]).length
                  })}
                {dirty && <span>{t('catalogDefaultsUnsaved')}</span>}
                {error && (
                  <span>
                    {t(draft ? 'catalogDefaultsFieldFailed' : 'catalogDefaultsLoadFailed')}
                  </span>
                )}
              </span>
            ),
            content: (
              <>
                <p className="field-hint prose">{t('catalogUpdaterDefaultsScope')}</p>
                {!editable && <p className="field-hint">{t('catalogDefaultsReadOnly')}</p>}
                {!draft && !error && (
                  <LoadingState count={2} label={t('catalogUpdaterDefaultsTitle')} />
                )}
                {error && (
                  <ErrorState
                    message={error}
                    onRetry={() => (draft ? void save() : setRevision(value => value + 1))}
                    retryLabel={t('catalogUpdaterRetry')}
                  />
                )}
                {draft && (
                  <form
                    className="catalog-defaults-form"
                    onSubmit={event => {
                      event.preventDefault();
                      void save();
                    }}
                  >
                    {FIELDS.map(([field, , set, label, hint]) => (
                      <div key={field} className="catalog-defaults-row">
                        <Checkbox
                          checked={draft[field]}
                          disabled={!editable || !client[set] || saving}
                          label={t(label)}
                          onChange={checked => {
                            setDraft({ ...draft, [field]: checked });
                            setConfirmed(false);
                            setFieldResults(current => ({ ...current, [field]: undefined }));
                            flow.current?.stage('draft_changed');
                          }}
                        />
                        <DefaultsHelp label={t(label)} hint={t(hint)} />
                        {!client[set] && (
                          <span className="field-hint">{t('catalogDefaultsUnavailable')}</span>
                        )}
                        {fieldResults[field] && (
                          <span
                            className={
                              fieldResults[field] === 'failed' ? 'team-inline-error' : 'field-hint'
                            }
                            role="status"
                          >
                            {t(
                              fieldResults[field] === 'failed'
                                ? 'catalogDefaultsFieldFailed'
                                : 'catalogDefaultsFieldSaved'
                            )}
                          </span>
                        )}
                      </div>
                    ))}
                    {editable && (
                      <div className="settings-section-actions">
                        <Button
                          type="submit"
                          color="success"
                          loading={saving}
                          disabled={!changed.length}
                        >
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
                            setFieldResults({});
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
              </>
            )
          }
        ]}
      />
    </section>
  );
}

function DefaultsHelp({ label, hint }: { label: string; hint: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  return (
    <span ref={anchor}>
      <IconButton
        label={label}
        title={hint}
        variant="ghost"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
      >
        <CircleHelp size={ICON_SIZE} strokeWidth={ICON_STROKE} />
      </IconButton>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label={label}>
        <p className="prose">{hint}</p>
      </Popover>
    </span>
  );
}
