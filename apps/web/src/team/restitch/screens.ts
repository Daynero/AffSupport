/**
 * The pictures a job will carry, drawn from the space (030).
 *
 * The server picks one picture per slot from the space's Drive pools; this asks it to, then
 * asks for an ordinary download grant on each picture — the same grant a video travels on —
 * and hands the agent the lot. No bytes pass through the browser. A grant the member cannot
 * get (no download right, a file past the ceiling) is tried once more with that picture
 * excluded, and then named for what it is.
 */

import type { RestitchScreen, TeamRestitchDefaults } from '@video-compressor/shared';
import { TeamApiError, teamApi } from '../../api/team';
import { agentCanRestitchFromSpace } from '../../api/client';

export type RestitchScreensOutcome =
  /** The space still points at a library: the caller goes the old way. */
  | { kind: 'legacy' }
  /** The app on this computer predates Drive pools. */
  | { kind: 'too-old' }
  | { kind: 'ready'; screens: RestitchScreen[] };

export interface RestitchScreensDeps {
  draw: typeof teamApi.drawRestitchScreens;
  grant: typeof teamApi.requestDownload;
  capable: () => Promise<'yes' | 'too-old' | 'unreachable'>;
}

const defaultDeps: RestitchScreensDeps = {
  draw: (teamId, options) => teamApi.drawRestitchScreens(teamId, options),
  grant: (teamId, materialId, consumer) => teamApi.requestDownload(teamId, materialId, consumer),
  capable: agentCanRestitchFromSpace
};

const RETRY_CODES = new Set(['PERMISSION_DENIED', 'TOO_LARGE', 'NOT_FOUND', 'UNSUPPORTED_MEDIA']);

function codeOf(error: unknown): string {
  if (error instanceof TeamApiError) return error.code;
  return error instanceof Error ? error.message : '';
}

export async function prepareRestitchScreens(
  teamId: string,
  known: TeamRestitchDefaults,
  deps: RestitchScreensDeps = defaultDeps
): Promise<RestitchScreensOutcome> {
  if (known.sourceMode !== 'drive') return { kind: 'legacy' };
  if ((await deps.capable()) !== 'yes') return { kind: 'too-old' };

  let drawn = await deps.draw(teamId);
  if (drawn.sourceMode !== 'drive') return { kind: 'legacy' };
  // At most two slots. Request independent grants together and wait for both
  // outcomes before a redraw, so a late old grant cannot enter the new draw.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const results = await Promise.allSettled(
      drawn.screens.map(async screen => {
        const grant = await deps.grant(teamId, screen.materialId, 'agent');
        if (grant.kind !== 'agent') throw new Error('AGENT_UPDATE_REQUIRED');
        return {
          slot: screen.slot,
          materialId: screen.materialId,
          checksum: screen.checksum,
          mimeType: screen.mimeType,
          fileName: screen.fileName,
          sizeBytes: screen.sizeBytes,
          transfer: { transferUrl: grant.transferUrl, grant: grant.grant }
        } satisfies RestitchScreen;
      })
    );
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [{ error: result.reason as unknown, materialId: drawn.screens[index]!.materialId }]
        : []
    );
    if (failures.length === 0)
      return {
        kind: 'ready',
        screens: results.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []))
      };
    if (attempt === 0 && failures.every(failure => RETRY_CODES.has(codeOf(failure.error)))) {
      drawn = await deps.draw(teamId, { exclude: failures.map(failure => failure.materialId) });
      if (drawn.sourceMode !== 'drive') return { kind: 'legacy' };
      continue;
    }
    const failure = failures.find(item => !RETRY_CODES.has(codeOf(item.error))) ?? failures[0]!;
    if (codeOf(failure.error) === 'PERMISSION_DENIED')
      throw new TeamApiError('RESTITCH_SOURCE_FORBIDDEN', false);
    throw failure.error;
  }
  throw new TeamApiError('RESTITCH_POOL_EMPTY', false);
}
