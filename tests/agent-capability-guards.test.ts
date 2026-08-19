import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformCapabilities } from '../apps/agent/src/platform/platform.js';

const platformMock = vi.hoisted(() => ({
  capabilities: vi.fn()
}));

// The route guards must gate on the declared capability, never on the OS, so the
// platform layer is the only thing these tests stub.
vi.mock('../apps/agent/src/platform/platform.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/agent/src/platform/platform.js')>();
  return { ...actual, capabilities: platformMock.capabilities };
});

const pickerMock = vi.hoisted(() => ({
  selectVideos: vi.fn(async () => [] as string[]),
  selectOutputFolder: vi.fn(async () => null)
}));

vi.mock('../apps/agent/src/files/picker.js', () => pickerMock);

const { registerCompressorRoutes } = await import('../apps/agent/src/compressor/routes.js');
const { registerMediaActionRoutes } = await import('../apps/agent/src/media-actions/routes.js');
const { MediaActionQueue } = await import('../apps/agent/src/media-actions/queue.js');

const WINDOWS: PlatformCapabilities = {
  nativeFilePicker: true,
  revealInFileManager: true,
  spotlightSearch: false,
  shellContextMenuIntegration: false,
  processPause: false
};

const MACOS: PlatformCapabilities = {
  nativeFilePicker: true,
  revealInFileManager: true,
  spotlightSearch: true,
  shellContextMenuIntegration: true,
  processPause: true
};

const NO_PICKER: PlatformCapabilities = { ...WINDOWS, nativeFilePicker: false };

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  vi.clearAllMocks();
});

async function compressorApp(): Promise<FastifyInstance> {
  const app = Fastify();
  // Only the picker route is exercised; the guard runs before anything else is
  // touched, so the remaining collaborators stay inert stubs.
  registerCompressorRoutes(app, {
    queue: { add: async () => [], state: () => ({}) },
    estimator: { pause: async () => {}, resume: () => {}, shutdown: async () => {} },
    imageStore: {},
    events: { handler: async () => {}, publish: () => {} },
    tools: { ffmpeg: true, ffprobe: true }
  } as unknown as Parameters<typeof registerCompressorRoutes>[1]);
  await app.ready();
  apps.push(app);
  return app;
}

async function mediaActionsApp(): Promise<FastifyInstance> {
  const app = Fastify();
  registerMediaActionRoutes(app, {
    mediaActions: new MediaActionQueue(),
    acceptingNewTasks: () => true
  });
  await app.ready();
  apps.push(app);
  return app;
}

describe('native file picker guard', () => {
  it('serves the picker on Windows, where the capability is present', async () => {
    platformMock.capabilities.mockReturnValue(WINDOWS);
    const app = await compressorApp();

    const response = await app.inject({ method: 'POST', url: '/api/files/select' });

    expect(response.statusCode).toBe(200);
    expect(pickerMock.selectVideos).toHaveBeenCalled();
  });

  it('serves the picker on macOS', async () => {
    platformMock.capabilities.mockReturnValue(MACOS);
    const app = await compressorApp();

    const response = await app.inject({ method: 'POST', url: '/api/files/select' });

    expect(response.statusCode).toBe(200);
  });

  it('refuses with a stable machine code where no native chooser exists', async () => {
    platformMock.capabilities.mockReturnValue(NO_PICKER);
    const app = await compressorApp();

    const response = await app.inject({ method: 'POST', url: '/api/files/select' });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toEqual({ error: 'NATIVE_FILE_PICKER_UNSUPPORTED' });
    expect(pickerMock.selectVideos).not.toHaveBeenCalled();
  });
});

describe('Finder image conversion guard', () => {
  it('refuses on Windows with a stable machine code, not a human sentence', async () => {
    platformMock.capabilities.mockReturnValue(WINDOWS);
    const app = await mediaActionsApp();

    const response = await app.inject({
      method: 'POST',
      url: '/native/media-actions/images/convert',
      payload: { paths: ['/tmp/a.png'], format: 'jpeg' }
    });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toEqual({ error: 'FINDER_IMAGE_CONVERSION_UNSUPPORTED' });
  });

  it('passes the guard on macOS and reaches request validation', async () => {
    platformMock.capabilities.mockReturnValue(MACOS);
    const app = await mediaActionsApp();

    const response = await app.inject({
      method: 'POST',
      url: '/native/media-actions/images/convert',
      payload: { paths: ['not-absolute'], format: 'jpeg' }
    });

    // 400 (not 501) proves the platform guard let the request through.
    expect(response.statusCode).toBe(400);
  });
});
