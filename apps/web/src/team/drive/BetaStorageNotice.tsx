import { configuredEnvironment } from '../../lib/config';
import { pickerConfig } from '../storage/loadPicker';
import { useI18n } from '../../i18n';

/**
 * Explains why external storage cannot be connected, when the reason is that
 * this is a beta environment with no external-storage credential configured.
 *
 * Beta is deliberately usable with no third-party account at all, so this state
 * is expected rather than broken — but it must be stated, and the flow must not
 * fall through to the production integration. Once the maintainer completes the
 * documented opt-in, the server stops reporting `unavailable` and this notice
 * disappears on its own.
 */
/**
 * A caller that already knows the connection state passes it. A caller that
 * does not — the space-creation wizard reaches this step before any status
 * call — passes nothing and gets the advisory, which is the fail-closed
 * reading used everywhere else in this feature: not knowing that external
 * storage is reachable must never be treated as knowing that it is.
 */
export function externalStorageUnavailableInBeta(state?: string): boolean {
  if (configuredEnvironment() !== 'beta') return false;
  // The chooser keys are the browser's half of the opt-in, and they are only
  // present once someone has done it. Without this the advisory outlived the
  // setup it describes: the wizard asks before any status call, so `undefined`
  // kept it on the screen in a beta whose storage was fully configured.
  if (pickerConfig() !== null) return false;
  return state === undefined || state === 'unavailable';
}

export function BetaStorageNotice({ state }: { state?: string }) {
  const { t } = useI18n();
  if (!externalStorageUnavailableInBeta(state)) return null;
  return (
    <p className="team-beta-storage-notice" role="note">
      <strong>{t('betaExternalStorageUnavailable')}</strong>{' '}
      {t('betaExternalStorageUnavailableHint')}
    </p>
  );
}
