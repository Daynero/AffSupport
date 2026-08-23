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
    listMembers: vi.fn().mockResolvedValue([]),
    updateMembership: vi.fn(),
    removeMember: vi.fn(),
    transferOwnership: vi.fn(),
    listAuditEvents: vi.fn().mockResolvedValue([]),
    listInvitations: vi.fn().mockResolvedValue([]),
    createInvitation: vi.fn(),
    getConnectionStatus: vi.fn().mockResolvedValue({ state: 'connected' }),
    listFolders: vi.fn().mockResolvedValue({ folders: [], nextPageToken: null }),
    confirmDriveRoot: vi.fn(),
    listMaterials: vi.fn().mockResolvedValue([]),
    searchCatalog: vi.fn().mockResolvedValue(emptySearch),
    getCatalogVocabulary: vi
      .fn()
      .mockResolvedValue({ geo: [], languages: [], offers: [], tags: [] }),
    updateMaterialMetadata: vi.fn(),
    ...overrides
  } as TeamSpaceClient;
}
