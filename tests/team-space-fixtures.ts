import { vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import type { TeamContextSnapshot } from '../apps/web/src/api/team';
import type { TeamSpaceClient } from '../apps/web/src/team/TeamSpace';

// Shared, non-test fixtures for the guided-team-space DOM tests. (Not a *.test
// file, so vitest does not collect it as a suite.)

export function makeTeam(overrides: Partial<TeamContextSnapshot> = {}): TeamContextSnapshot {
  return {
    id: '20000000-0000-4000-8000-000000000001',
    name: 'Media buyers',
    role: 'owner',
    permissions: DEFAULT_ROLE_PERMISSIONS.owner,
    connectionState: 'connected',
    ...overrides
  };
}

const emptySearch = {
  items: [],
  total: 0,
  activeFilters: {},
  facets: {},
  catalogFreshness: { state: 'not_started', lastSyncedAt: null }
};

export function makeClient(overrides: Partial<TeamSpaceClient> = {}): TeamSpaceClient {
  return {
    listTeams: vi.fn().mockResolvedValue([]),
    listMyInvitations: vi.fn().mockResolvedValue([]),
    createTeam: vi.fn(),
    deleteDraftTeam: vi.fn().mockResolvedValue(true),
    leaveTeam: vi
      .fn()
      .mockResolvedValue({ ok: true, warningCode: 'EXTERNAL_DRIVE_ACCESS_REMAINS' }),
    // 015 — the space's re-stitching defaults. Unset by default, which is the state most
    // surfaces should be able to render.
    getRestitchDefaults: vi.fn().mockResolvedValue(null),
    setRestitchDefaults: vi.fn(),
    getMaterialRestitchPrep: vi.fn().mockResolvedValue(new Map()),
    setMaterialRestitchPrep: vi.fn(),
    listMembers: vi.fn().mockResolvedValue([]),
    updateMembership: vi.fn(),
    removeMember: vi.fn(),
    transferOwnership: vi.fn(),
    listAuditEvents: vi.fn().mockResolvedValue([]),
    listInvitations: vi.fn().mockResolvedValue([]),
    createInvitation: vi.fn(),
    getConnectionStatus: vi.fn().mockResolvedValue({ state: 'connected' }),
    pickerToken: vi.fn().mockResolvedValue({ accessToken: 'picker-token', expiresAt: 'later' }),
    chooseRoot: vi.fn(),
    confirmDriveRoot: vi.fn(),
    listFolderTree: vi.fn().mockResolvedValue([]),
    listFolderPage: vi.fn().mockResolvedValue({ rows: [], total: 0, next: null }),
    mintThumbnailSession: vi.fn().mockResolvedValue({
      token: 'thumb-session',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      teamId: 'team',
      endpoint: 'https://p.supabase.co/functions/v1/drive-transfer/thumbnail'
    }),
    thumbnailUrl: (session: { endpoint: string; token: string }, materialId: string) =>
      `${session.endpoint}?material=${materialId}&session=${session.token}`,
    listDriveSelections: vi.fn().mockResolvedValue([]),
    listMaterials: vi.fn().mockResolvedValue([]),
    searchCatalog: vi.fn().mockResolvedValue(emptySearch),
    getCatalogVocabulary: vi
      .fn()
      .mockResolvedValue({ geo: [], languages: [], offers: [], tags: [] }),
    updateMaterialMetadata: vi.fn(),
    ...overrides
  } as TeamSpaceClient;
}
