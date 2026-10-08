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
  const screens: RestitchScreen[] = [];
  const excluded: string[] = [];
  let retried = false;
  for (let index = 0; index < drawn.screens.length; index += 1) {
    const screen = drawn.screens[index]!;
    try {
      const grant = await deps.grant(teamId, screen.materialId, 'agent');
      if (grant.kind !== 'agent') throw new Error('AGENT_UPDATE_REQUIRED');
      screens.push({
        slot: screen.slot,
        materialId: screen.materialId,
        checksum: screen.checksum,
        mimeType: screen.mimeType,
        fileName: screen.fileName,
        sizeBytes: screen.sizeBytes,
        transfer: { transferUrl: grant.transferUrl, grant: grant.grant }
      });
    } catch (error) {
      const code = codeOf(error);
      // One more draw without this picture; a second refusal is the member's rights, not luck.
      if (!retried && RETRY_CODES.has(code)) {
        retried = true;
        excluded.push(screen.materialId);
        drawn = await deps.draw(teamId, { exclude: excluded });
        screens.length = 0;
        index = -1;
        continue;
      }
      if (code === 'PERMISSION_DENIED') throw new TeamApiError('RESTITCH_SOURCE_FORBIDDEN', false);
      throw error;
    }
  }
  return { kind: 'ready', screens };
}
