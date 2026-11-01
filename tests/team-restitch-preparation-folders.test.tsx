// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const stubs = vi.hoisted(() => ({
  list: vi.fn(async (_team: string, input: { parentFolderId: string | null }) => ({
    rows:
      input.parentFolderId === 'drive-folder'
        ? [{ id: 'material', kind: 'video', name: 'creative.mp4', driveVersion: '1' }]
        : [],
    next: null
  })),
  download: vi.fn(async () => ({
    kind: 'agent',
    transferUrl: 'http://localhost/transfer',
    grant: 'local-test-grant'
  })),
  prepare: vi.fn(async () => undefined)
}));
vi.mock('../apps/web/src/api/team', () => ({
  teamApi: {
    ensureWorkspaceFolder: vi.fn(async () => ({})),
    listFolderTree: vi.fn(async () => [{ id: 'catalog-uuid', driveFileId: 'drive-folder' }]),
    listFolderPage: stubs.list,
    getMaterialRestitchPrep: vi.fn(async () => new Map()),
    requestDownload: stubs.download,
    setMaterialRestitchPrep: vi.fn()
  }
}));
vi.mock('../apps/web/src/api/client', () => ({
  agentCanRestitch: vi.fn(async () => 'yes'),
  cancelTeamRestitchPreparation: vi.fn(),
  prepareTeamRestitchMaterials: stubs.prepare,
  readTeamRestitchPreparation: vi.fn(async () => null)
}));
vi.mock('../apps/web/src/analytics/service', () => ({
  startTeamWorkflow: vi.fn(() => ({})),
  completeTeamWorkflow: vi.fn()
}));
import { useRestitchPreparation } from '../apps/web/src/team/restitch/useRestitchPreparation';
it('prepares nested videos using Drive folder identities rather than catalog row UUIDs', async () => {
  const { result } = renderHook(() => useRestitchPreparation('team'));
  await act(async () => {
    await result.current.prepare();
  });
  expect(stubs.list).toHaveBeenCalledWith(
    'team',
    expect.objectContaining({ parentFolderId: 'drive-folder' })
  );
  expect(stubs.download).toHaveBeenCalledWith('team', 'material', 'agent');
  expect(stubs.prepare).toHaveBeenCalledWith(
    expect.objectContaining({ materials: [expect.objectContaining({ materialId: 'material' })] })
  );
  expect(result.current.state.phase).toBe('finished');
});
