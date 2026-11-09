import type { TeamRestitchDefaults } from '../../../packages/shared/dist/team/restitch.js';
import { TeamFunctionError } from '../_shared/errors.ts';
/** A child samples from its immutable server identity. Lost grant acknowledgements
 * reconstruct the same duration without a fresh draw or current team defaults. */
export async function sampleCatalogVideoDuration(
  settings: TeamRestitchDefaults & { finalDurationRangeSeconds?: [number, number] },
  identity: { setId: string; requestId: string; settingsDigest: string }
): Promise<TeamRestitchDefaults> {
  const mode = settings.finalDurationMode;
  if (mode === 'custom') return { ...settings };
  let low: number, high: number;
  if (mode === 'random-centered') {
    const center = Math.max(
      60,
      Math.min(3600, Math.round(settings.customFinalDurationSeconds / 60) * 60)
    );
    [low, high] = settings.finalDurationRangeSeconds ?? [
      Math.max(60, center - 300),
      Math.min(3600, center + 300)
    ];
  } else if (mode === 'random-30-40') {
    low = 1800;
    high = 2400;
  } else if (mode === 'random-40-50') {
    low = 2400;
    high = 3000;
  } else if (mode === 'random-50-60') {
    low = 3000;
    high = 3600;
  } else throw new TeamFunctionError('RESTITCH_INVALID');
  if (!Number.isInteger(low) || !Number.isInteger(high) || low < 60 || high > 3600 || low > high)
    throw new TeamFunctionError('RESTITCH_INVALID');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([
        'catalog-video-duration-v1',
        identity.setId,
        identity.requestId,
        identity.settingsDigest
      ])
    )
  );
  const draw = new DataView(digest).getUint32(0, false) / 4294967296;
  const frozen = {
    ...settings,
    finalDurationMode: 'custom' as const,
    customFinalDurationSeconds: low + Math.floor(draw * (high - low + 1))
  };
  delete frozen.finalDurationRangeSeconds;
  return frozen;
}
