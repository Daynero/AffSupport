import React, { Profiler, type ReactNode } from 'react';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import { TeamProvider } from '../../apps/web/src/team/TeamContext';
import { ToastProvider } from '../../apps/web/src/components/toast';
import { AuthContextOverride, type AuthContextValue } from '../../apps/web/src/auth/AuthContext';
import { CatalogUpdaterDialog } from '../../apps/web/src/team/catalog-updater/CatalogUpdaterDialog';
import {
  catalogManagerPerformanceFixture,
  CATALOG_PERFORMANCE_TEAM
} from '../fixtures/catalog-manager-performance';
/** Test-only injected client: never reaches a provider, network, auth shortcut,
 * or writable endpoint. Browser caller supplies its existing authenticated context. */
export function createCatalogManagerPerformanceHarness(
  size: number,
  transport: 'atomic' | 'split' = 'atomic'
) {
  const fixture = catalogManagerPerformanceFixture(size);
  const counts = {
    profilerObserved: false,
    commits: 0,
    managerReads: 0,
    catalogReads: 0,
    profileReads: 0,
    stateReads: 0,
    profileElementReads: 0,
    writes: 0
  };
  const catalogRows =
    transport === 'split'
      ? fixture.rows.map(row => ({ ...row, profile: undefined }))
      : fixture.rows;
  const readProfiles = new Proxy(fixture.profiles, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/u.test(key)) counts.profileElementReads++;
      return Reflect.get(target, key, receiver);
    }
  });
  const refuse = async (): Promise<never> => {
    counts.writes++;
    throw Error('A26 fixture is read-only');
  };
  const client = {
    ...(transport === 'atomic'
      ? {
          async listCatalogManagerSnapshot() {
            counts.managerReads++;
            return { rows: fixture.rows, invalidRowCount: 0 };
          }
        }
      : {}),
    async listTeamProductCatalogs() {
      counts.catalogReads++;
      return catalogRows;
    },
    async listCatalogUpdateProfiles() {
      counts.profileReads++;
      return readProfiles;
    },
    async getCatalogUpdater() {
      counts.stateReads++;
      return fixture.updater;
    },
    patchCatalogUpdateProfile: refuse,
    setCatalogUpdateInterval: refuse,
    runCatalogUpdateNow: refuse,
    cancelCatalogUpdate: refuse,
    setCatalogUpdaterRestitch: refuse
  };
  function Harness({ auth }: { auth?: AuthContextValue }) {
    let content: ReactNode = (
      <Profiler
        id="a26-manager"
        onRender={() => {
          counts.profilerObserved = true;
          counts.commits++;
        }}
      >
        <TeamProvider
          initialTeams={[
            {
              id: CATALOG_PERFORMANCE_TEAM,
              name: 'A26 synthetic team',
              role: 'owner',
              permissions: DEFAULT_ROLE_PERMISSIONS.owner,
              connectionState: 'connected'
            }
          ]}
          realtime={false}
        >
          <ToastProvider>
            <CatalogUpdaterDialog
              teamId={CATALOG_PERFORMANCE_TEAM}
              client={client}
              onClose={() => {}}
              onChanged={() => {}}
              onReveal={() => {}}
            />
          </ToastProvider>
        </TeamProvider>
      </Profiler>
    );
    if (auth) content = <AuthContextOverride value={auth}>{content}</AuthContextOverride>;
    return content;
  }
  return { fixture, client, counts, Harness, snapshotCounts: () => ({ ...counts }) };
}
