import { useEffect, useRef, useState } from 'react';
import type { CatalogUpdateProfile, CatalogUpdateProfilePatch } from '@video-compressor/shared';
import { Button, Checkbox, ConfirmDialog } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { TeamApiError, type CatalogUpdaterInterval } from '../../api/team';
import { beginCatalogUiFlow, type CatalogUiFlow } from './analytics';
import { UpdaterIntervalPicker, intervalLabel } from './UpdaterIntervalPicker';

const FIELDS = [
  ['randomLinkVariation', 'catalogRandomLinkVariation', 'catalogUpdaterLinkVariationEffect'],
  ['refreshImages', 'catalogUpdaterRefreshImages', 'catalogUpdaterImagesEffect'],
  ['refreshTexts', 'catalogUpdaterRefreshTexts', 'catalogUpdaterTextsEffect'],
  ['growProducts', 'catalogUpdaterGrow', 'catalogUpdaterGrowEffect'],
  ['restitch', 'catalogUpdaterRestitch', 'catalogUpdaterRestitchEffect']
] as const;

export function CatalogProfileEditor({
  profile,
  catalogName,
  interval,
  save,
  loadCurrent,
  onSaved,
  onClose,
  onDirtyChange,
  onPendingChange,
  activeAttempt = false
}: {
  profile: CatalogUpdateProfile;
  catalogName: string;
  interval: CatalogUpdaterInterval | null;
  save: (
    expectedVersion: number,
    patch: CatalogUpdateProfilePatch
  ) => Promise<CatalogUpdateProfile>;
  loadCurrent?: () => Promise<{
    profile: CatalogUpdateProfile;
    interval: CatalogUpdaterInterval | null;
  }>;
  onSaved: (
    flow?: CatalogUiFlow,
    savedProfile?: CatalogUpdateProfile,
    savedInterval?: CatalogUpdaterInterval | null
  ) => void;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
  activeAttempt?: boolean;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<CatalogUpdateProfilePatch>({});
  const [baseline, setBaseline] = useState({ profile, interval });
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = Object.keys(draft).length > 0;
  const [pending, setPending] = useState(false);
  useEffect(() => {
    onPendingChange?.(pending);
    return () => onPendingChange?.(false);
  }, [pending, onPendingChange]);
  const flow = useRef<CatalogUiFlow | null>(null);
  const draftRecorded = useRef(false);
  useEffect(() => {
    flow.current = beginCatalogUiFlow('profile', { count: 1 });
    return () => {
      flow.current?.cancel();
    };
  }, []);
  useEffect(() => {
    if (dirty && !draftRecorded.current) {
      flow.current?.stage('draft_changed');
      draftRecorded.current = true;
    }
  }, [dirty]);
  useEffect(() => {
    if (!dirty && !pending) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty, pending]);
  useEffect(() => {
    if (!dirty) setBaseline({ profile, interval });
  }, [profile, interval, dirty]);
  useEffect(() => {
    onDirtyChange?.(dirty || pending);
  }, [dirty, pending, onDirtyChange]);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    profile: CatalogUpdateProfile;
    interval: CatalogUpdaterInterval | null;
  } | null>(null);
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const base = conflict?.profile ?? baseline.profile;
  const baseInterval = conflict ? conflict.interval : baseline.interval;
  const overlappingFields = conflict
    ? FIELDS.filter(
        ([field]) =>
          draft[field] !== undefined &&
          baseline.profile[field] !== conflict.profile[field] &&
          draft[field] !== conflict.profile[field]
      )
    : [];
  const intervalOverlaps =
    conflict &&
    draft.updateInterval !== undefined &&
    baseline.interval !== conflict.interval &&
    draft.updateInterval !== conflict.interval;
  const hasOverlap = overlappingFields.length > 0 || Boolean(intervalOverlaps);
  const selected = [
    t('catalogUpdaterIds'),
    ...FIELDS.filter(([field]) => draft[field] ?? base[field]).map(([, key]) => t(key))
  ];
  const nextInterval = draft.updateInterval === undefined ? baseInterval : draft.updateInterval;

  const submit = async () => {
    if (Object.keys(draft).length === 0) return;
    if (hasOverlap && !overwriteConfirmed) {
      setOverwriteConfirmed(true);
      return;
    }
    const attemptFlow = flow.current ?? beginCatalogUiFlow('profile', { count: 1 });
    flow.current = attemptFlow;
    attemptFlow.stage('save_requested');
    setPending(true);
    setError(null);
    try {
      const savedProfile = await save(conflict?.profile.version ?? baseline.profile.version, draft);
      attemptFlow.stage('save_confirmed');
      flow.current = null;
      onDirtyChange?.(false);
      onSaved(attemptFlow, savedProfile, nextInterval);
      onClose();
    } catch (cause) {
      attemptFlow.fail(
        cause instanceof TeamApiError && cause.code === 'STALE_RESULT' ? 'CONFLICT' : 'SAVE_FAILED'
      );
      flow.current = null;
      setError(teamErrorMessageFor(cause, t));
      if (cause instanceof TeamApiError && cause.code === 'STALE_RESULT' && loadCurrent) {
        try {
          setConflict(await loadCurrent());
          setOverwriteConfirmed(false);
        } catch {
          /* Keep the original error. */
        }
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="team-updater-profile" role="group" aria-label={t('catalogUpdaterProfile')}>
      {activeAttempt && (
        <p className="field-hint" role="status">
          {t('catalogUpdaterProfileActiveAttempt')}
        </p>
      )}
      <strong>{t('catalogUpdaterWhen')}</strong>
      <UpdaterIntervalPicker
        value={nextInterval}
        label={t('catalogUpdaterIntervalFor', { name: catalogName })}
        disabled={pending}
        onChange={value => {
          setDraft(current => {
            const next = { ...current };
            if (value === baseInterval) delete next.updateInterval;
            else next.updateInterval = value;
            return next;
          });
          setOverwriteConfirmed(false);
        }}
      />
      <p className="field-hint">
        {t('catalogUpdaterProfileSchedulePreview', {
          interval: intervalLabel(nextInterval, t)
        })}
      </p>
      <strong>{t('catalogUpdaterWhat')}</strong>
      <div className="team-updater-profile-choices">
        {FIELDS.map(([field, label, effect]) => (
          <div key={field}>
            <Checkbox
              checked={draft[field] ?? base[field]}
              disabled={pending}
              onChange={checked => {
                setDraft(current => {
                  const next = { ...current };
                  if (checked === base[field]) delete next[field];
                  else next[field] = checked;
                  return next;
                });
                setOverwriteConfirmed(false);
              }}
              label={t(label)}
            />
            <details>
              <summary>{t('catalogUpdaterDetails')}</summary>
              <small className="field-hint">{t(effect)}</small>
            </details>
          </div>
        ))}
      </div>
      {(draft.restitch ?? base.restitch) && (
        <p className="field-hint" role="status">
          {profile.restitchStatus === 'ready'
            ? t('catalogUpdaterRestitchReady')
            : profile.restitchStatus === 'preparing'
              ? t('catalogUpdaterRestitchPreparing')
              : profile.restitchStatus === 'blocked' && profile.restitchBlockedCode
                ? teamErrorMessageFor({ code: profile.restitchBlockedCode }, t)
                : t('catalogUpdaterRestitchWaiting')}{' '}
          {t('catalogUpdaterRestitchReadiness')}
        </p>
      )}
      <p className="field-hint">
        {t('catalogUpdaterProfilePreview', {
          changes: selected.join(', ')
        })}
      </p>
      {error && (
        <p className="team-inline-error" role="alert">
          {error}
        </p>
      )}
      {conflict && (
        <div className="team-inline-error" role="alert">
          <strong>{t('catalogUpdaterProfileConflict')}</strong>
          <p>
            {t('catalogUpdaterProfileSchedulePreview', {
              interval: intervalLabel(conflict.interval, t)
            })}
          </p>
          <ul>
            {FIELDS.filter(([field]) => conflict.profile[field] !== baseline.profile[field]).map(
              ([field, label]) => (
                <li key={field}>
                  {t(label)}:{' '}
                  {baseline.profile[field] ? t('catalogUpdaterBulkOn') : t('catalogUpdaterBulkOff')}{' '}
                  →{' '}
                  {conflict.profile[field] ? t('catalogUpdaterBulkOn') : t('catalogUpdaterBulkOff')}
                </li>
              )
            )}
          </ul>
          <p>{t('catalogUpdaterProfileConflictAction')}</p>
          {hasOverlap && (
            <p>
              {t('catalogUpdaterProfileOverlap', {
                changes: [
                  ...overlappingFields.map(([, label]) => t(label)),
                  ...(intervalOverlaps ? [t('catalogUpdaterFilterInterval')] : [])
                ].join(', ')
              })}
            </p>
          )}
          {hasOverlap && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(current => {
                  const next = { ...current };
                  for (const [field] of overlappingFields) delete next[field];
                  if (intervalOverlaps) delete next.updateInterval;
                  return next;
                });
                setOverwriteConfirmed(false);
              }}
            >
              {t('catalogUpdaterKeepOtherChanges')}
            </Button>
          )}
        </div>
      )}
      {hasOverlap && overwriteConfirmed && (
        <p className="field-hint" role="status" aria-live="polite">
          {t('catalogUpdaterConfirmOverwriteAgain')}
        </p>
      )}
      {confirmDiscard && (
        <ConfirmDialog
          nested
          title={t('catalogUpdaterDiscardTitle')}
          body={t('catalogUpdaterDiscardBody')}
          confirmLabel={t('catalogUpdaterDiscard')}
          cancelLabel={t('catalogUpdaterKeepEditing')}
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            onDirtyChange?.(false);
            onClose();
          }}
        />
      )}
      <div className="team-updater-profile-actions">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => (dirty ? setConfirmDiscard(true) : onClose())}
          disabled={pending}
        >
          {t('catalogUpdaterClose')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => void submit()}
          disabled={pending || Object.keys(draft).length === 0}
        >
          {hasOverlap && !overwriteConfirmed
            ? t('catalogUpdaterConfirmOverwrite')
            : conflict
              ? t('catalogUpdaterSaveWithLatest')
              : t('catalogUpdaterSaveProfile')}
        </Button>
      </div>
    </div>
  );
}
