// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentRestitchContractVersion } from '../apps/web/src/api/client';
beforeEach(() => {
  localStorage.setItem('agentToken', 'a'.repeat(64));
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});
const base = { teamWorkspace: 1, stitcher: 1, imageEmbedding: 2 };
function health(toolContracts: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ toolContracts })))
  );
}
it.each([
  [undefined, 1],
  [1, 1],
  [2, 2],
  [3, 2]
])(
  'bounds actual installation protocol %s to executable web support',
  async (version, expected) => {
    health({ ...base, ...(version === undefined ? {} : { teamRestitchSources: version }) });
    expect(await agentRestitchContractVersion()).toBe(expected);
  }
);
it.each([0, -1, 1.5, '2', null])(
  'refuses malformed installed source capability %s',
  async version => {
    health({ ...base, teamRestitchSources: version });
    await expect(agentRestitchContractVersion()).rejects.toThrow('AGENT_UPDATE_REQUIRED');
  }
);
it.each([{}, { ...base, stitcher: 0 }, { ...base, imageEmbedding: '2' }])(
  'requires the actual tools used by the claimed process',
  async contracts => {
    health({ ...contracts, teamRestitchSources: 2 });
    await expect(agentRestitchContractVersion()).rejects.toThrow('AGENT_UPDATE_REQUIRED');
  }
);
it('preserves an unreachable installation as a refusal to claim', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('OFFLINE')));
  await expect(agentRestitchContractVersion()).rejects.toThrow();
});
