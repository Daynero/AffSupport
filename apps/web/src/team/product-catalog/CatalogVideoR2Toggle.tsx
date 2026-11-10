import { useEffect, useState } from 'react';
import type {
  CatalogVideoR2Availability,
  CatalogVideoR2State
} from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import type { CatalogVideoR2Client } from '../../api/team-catalog-video-r2';
import { Badge, Checkbox } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { useOptionalTeam } from '../TeamContext';

/**
 * «Копіювати відео в R2» (050), the same control wherever a catalog is made or
 * its auto-update is configured.
 *
 * `create`: a plain checkbox bound by the host form; it only appears when the
 * server says the feature is available, and only a member who may change the
 * catalog settings can tick it. `catalog`: the stored option of an existing
 * catalog, saved on the spot, with the source of the issued link (R2 or Drive),
 * the reason when R2 was not applied and the last successful update. Nothing
 * here publishes bytes; the next catalog update does (FR-003).
 */
export type CatalogVideoR2ToggleProps =
  | {
      mode: 'create';
      teamId: string;
      checked: boolean;
      onChange: (checked: boolean) => void;
      disabled?: boolean;
      client?: CatalogVideoR2Client;
    }
  | {
      mode: 'catalog';
      teamId: string;
      catalogMaterialId: string;
      disabled?: boolean;
      client?: CatalogVideoR2Client;
      onSaved?: (enabled: boolean) => void;
    };

function statusOf(state: CatalogVideoR2State, t: (key: never) => string) {
  const label = t as unknown as (key: string) => string;
  if (state.link === 'r2') return { color: 'success' as const, text: label('catalogVideoR2StatusR2') };
  if (!state.enabled) return { color: 'neutral' as const, text: label('catalogVideoR2StatusDrive') };
  if (state.copy && state.copy.state !== 'ready' && state.copy.state !== 'failed' && !state.reason)
    return { color: 'info' as const, text: label('catalogVideoR2StatusPending') };
  return { color: 'warning' as const, text: label('catalogVideoR2StatusFallback') };
}

export function CatalogVideoR2Toggle(props: CatalogVideoR2ToggleProps) {
  const { t, language } = useI18n();
  // Optional: the hosts render outside a space provider in their own tests; the
  // revisions only re-read the state after a Realtime invalidation.
  const team = useOptionalTeam();
  const revision = team?.revision ?? 0;
  const updaterRevision = team?.updaterRevision ?? 0;
  const client = props.client ?? teamApi.catalogVideoR2;
  const [availability, setAvailability] = useState<CatalogVideoR2Availability | null>(null);
  const [state, setState] = useState<CatalogVideoR2State | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const catalogId = props.mode === 'catalog' ? props.catalogMaterialId : null;

  useEffect(() => {
    const controller = new AbortController();
    void client
      .availability(props.teamId, { signal: controller.signal })
      .then(value => setAvailability(value))
      .catch(() => setAvailability({ available: false, reason: 'VIDEO_R2_NOT_CONFIGURED', canManage: false, contractVersion: 1 }));
    return () => controller.abort();
  }, [client, props.teamId]);

  useEffect(() => {
    if (!catalogId) return;
    const controller = new AbortController();
    void client
      .readState(catalogId, { signal: controller.signal })
      .then(value => setState(value))
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, catalogId, revision, updaterRevision]);

  if (!availability?.available) return null;
  // The server's answer is the permission predicate itself (FR-013), not a client-side guess.
  const canManage = state ? state.canManage : availability.canManage;
  const disabled = props.disabled === true || !canManage || saving;

  if (props.mode === 'create') {
    return (
      <div className="catalog-video-r2 flex flex-col gap-1" data-testid="catalog-video-r2-toggle">
        <Checkbox
          checked={props.checked}
          disabled={disabled}
          onChange={checked => props.onChange(checked)}
          label={t('catalogVideoR2Toggle')}
        />
        <p className="team-inline-note">{t('catalogVideoR2Explain')}</p>
        {!canManage && <p className="team-inline-note">{t('catalogVideoR2NoPermission')}</p>}
      </div>
    );
  }

  const status = state ? statusOf(state, t as never) : null;
  const reason = state?.reason ? teamErrorMessageFor({ code: state.reason }, t) : null;
  const lastUpdate = state?.lastSuccessfulUpdateAt
    ? new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(state.lastSuccessfulUpdateAt)
      )
    : t('catalogVideoR2Never');
  const toggle = async (checked: boolean) => {
    if (!catalogId) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const receipt = await client.setPreference(catalogId, { enabled: checked });
      setState(current => (current ? { ...current, enabled: receipt.enabled, revision: receipt.revision } : current));
      setSaved(true);
      (props as Extract<CatalogVideoR2ToggleProps, { mode: 'catalog' }>).onSaved?.(receipt.enabled);
    } catch (cause) {
      setError(teamErrorMessageFor(cause, t));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="catalog-video-r2 flex flex-col gap-1" data-testid="catalog-video-r2-toggle">
      <div className="flex items-center gap-2">
        <Checkbox
          checked={state?.enabled === true}
          disabled={disabled || !state}
          onChange={checked => void toggle(checked)}
          label={t('catalogVideoR2Toggle')}
        />
        {status && (
          <Badge color={status.color} variant="soft" data-testid="catalog-video-r2-status">
            {status.text}
          </Badge>
        )}
      </div>
      <p className="team-inline-note">{t('catalogVideoR2Explain')}</p>
      {state && (
        <p className="team-inline-note" data-testid="catalog-video-r2-last-update">
          {t('catalogVideoR2LastUpdate')}: {lastUpdate}
        </p>
      )}
      {reason && (
        <p className="team-inline-note" role="status" data-testid="catalog-video-r2-reason">
          {reason}
        </p>
      )}
      {state?.copy && state.link === 'r2' && !state.copy.fullHashVerified && (
        <p className="team-inline-note">{t('catalogVideoR2FullHashPartial')}</p>
      )}
      {!canManage && <p className="team-inline-note">{t('catalogVideoR2NoPermission')}</p>}
      {saved && (
        <p className="team-inline-note" role="status">
          {t('catalogVideoR2Saved')}
        </p>
      )}
      {error && (
        <p className="team-inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
