/**
 * The space's own re-stitch row, as its owner saved it (071).
 *
 * The settings screen edits what the person chose, and since 20261224170000 the effective
 * settings are not that: for agents up to 1.6.x the server rewrites the switches of a slot that
 * falls back to Soty's standard picture (a standard start becomes `startEnabled: false`), and a
 * space with both slots off has no effective settings at all. Read through those, the screen
 * would show a switch the person never turned off, or "on" for a space they switched off. The
 * raw row (`get_restitch_defaults`, `view` permission) is the person's answer; no row is the
 * out-of-the-box answer.
 */

import { parseTeamRestitchDefaults, type TeamRestitchDefaults } from '@video-compressor/shared';
import { requireSupabaseClient, withFreshSession } from '../../../lib/supabase';

export async function readRestitchRow(teamId: string): Promise<TeamRestitchDefaults | null> {
  const { data, error } = await withFreshSession(() =>
    requireSupabaseClient().rpc('get_restitch_defaults', { p_team: teamId })
  );
  if (error) throw new Error(error.message);
  // A composite that found nothing comes back as null, or as a record of nulls.
  if (!data || !data.team_id) return null;
  // 20261224271000 adds the range; the generated row type predates it.
  const range = (data as typeof data & { final_duration_range_seconds?: number[] | null })
    .final_duration_range_seconds;
  const parsed = parseTeamRestitchDefaults({
    operation: data.operation,
    startImageIds: data.start_image_ids,
    endImageIds: data.end_image_ids,
    fitMode: data.fit_mode,
    finalDurationMode: data.final_duration_mode,
    customFinalDurationSeconds: data.custom_final_duration_seconds,
    finalDurationRangeSeconds: range ?? undefined,
    startEnabled: data.start_enabled,
    endEnabled: data.end_enabled,
    startDurationMode: data.start_duration_mode,
    customStartDurationMs: data.custom_start_duration_ms,
    sourceMode: data.source_mode,
    configured: data.configured,
    updatedAt: data.updated_at,
    updatedBy: data.updated_by
  });
  if (!parsed.ok) throw new Error('INVALID_RESPONSE');
  return parsed.value;
}
