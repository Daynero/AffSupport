import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import {
  registerTeamBridgeRoutes,
  type TeamBridgeRoutesDeps
} from '../apps/agent/src/team-bridge/routes.js';

it('passes the space screens and their grants through the download HTTP route', async () => {
  const app = Fastify();
  const download = vi
    .fn()
    .mockResolvedValue({ saved: true, fileName: 'video_restitched.mp4', sizeBytes: 10 });
  registerTeamBridgeRoutes(app, {
    download: { download },
    events: { handler: vi.fn() },
    acceptingNewTasks: () => true
  } as unknown as TeamBridgeRoutesDeps);
  const grant = {
    ticket: 'opaque-download-range-ticket-with-enough-entropy',
    purpose: 'download_range',
    expiresAt: '2099-01-01T00:00:00.000Z',
    maxRangeBytes: 1024,
    maxUses: 10
  };
  const process = {
    tool: 'restitch',
    defaults: { sourceMode: 'drive', configured: true },
    teamId: 'team-1',
    screens: [
      {
        slot: 'start',
        materialId: 'image-1',
        transfer: { transferUrl: 'https://transfer.test/image', grant }
      }
    ]
  };
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/team/download',
      payload: {
        operationId: 'operation-1',
        transferUrl: 'https://transfer.test/video',
        transferGrant: grant,
        fileName: 'video.mp4',
        process
      }
    });
    expect(response.statusCode).toBe(200);
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({ process: expect.objectContaining(process) })
    );
  } finally {
    await app.close();
  }
});
