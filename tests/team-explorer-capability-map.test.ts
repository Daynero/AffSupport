import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Feature 011 (T055): the merge is auditable. Every explorer home the
 * capability map names exists, every surface the map says was removed is
 * gone, and the shell no longer reaches for any of them.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

const EXPLORER_HOMES = [
  'apps/web/src/team/explorer/ExplorerShell.tsx',
  'apps/web/src/team/explorer/ExplorerProvider.tsx',
  'apps/web/src/team/explorer/FolderTree.tsx',
  'apps/web/src/team/explorer/Breadcrumb.tsx',
  'apps/web/src/team/explorer/KindFilterBar.tsx',
  'apps/web/src/team/explorer/ContentGrid.tsx',
  'apps/web/src/team/explorer/ContentList.tsx',
  'apps/web/src/team/explorer/PreviewPane.tsx',
  'apps/web/src/team/explorer/RowActions.tsx',
  'apps/web/src/team/explorer/BackgroundRenderProvider.tsx',
  'apps/web/src/team/workspace/SettingsDialog.tsx',
  'apps/web/src/team/workspace/MembersSection.tsx',
  'apps/web/src/team/storage/ConnectStorageFlow.tsx'
];

describe('the explorer capability map', () => {
  it('has a file for every home it names', () => {
    for (const home of EXPLORER_HOMES) expect(existsSync(path.join(root, home)), home).toBe(true);
  });

  it('has removed every surface the contract says was merged away, and kept what it says it kept', () => {
    const contract = read('specs/011-team-workspace-rework/contracts/explorer-ui.md');
    const section = contract.slice(contract.indexOf('## Files removed after the merge'));
    const keptAt = section.indexOf('Kept on purpose');
    const analyticsAt = section.indexOf('## Analytics');
    const removed = [...section.slice(0, keptAt).matchAll(/`team\/([^`]+)`/gu)].map(m => m[1]);
    const kept = [...section.slice(keptAt, analyticsAt).matchAll(/`team\/([^`]+)`/gu)].map(
      m => m[1]
    );
    expect(removed.length).toBeGreaterThan(5);
    expect(kept.length).toBeGreaterThan(2);
    for (const file of removed) {
      expect(existsSync(path.join(root, 'apps/web/src/team', file)), `${file} should be gone`).toBe(
        false
      );
    }
    for (const file of kept) {
      expect(existsSync(path.join(root, 'apps/web/src/team', file)), `${file} should exist`).toBe(
        true
      );
    }
  });

  it('keeps the shell on the three destinations and the explorer', () => {
    const shell = read('apps/web/src/team/workspace/WorkspaceShell.tsx');
    for (const gone of ['MaterialBrowser', 'TeamLandings', 'CreativeLibrary', 'LandingGallery']) {
      expect(shell.includes(gone), gone).toBe(false);
    }
    expect(shell).toContain('ExplorerShell');
    expect(shell).toContain('MembersSection');
    expect(shell).toContain('SettingsDialog');
    const routes = read('apps/web/src/team/routes.ts');
    expect(routes).toContain(
      "export const TEAM_SECTIONS = ['explorer', 'tasks', 'members'] as const;"
    );
  });

  it('routes every former capability to a live explorer action', () => {
    const grid = read('apps/web/src/team/explorer/ContentGrid.tsx');
    const list = read('apps/web/src/team/explorer/ContentList.tsx');
    const shell = read('apps/web/src/team/explorer/ExplorerShell.tsx');
    const pane = read('apps/web/src/team/explorer/PreviewPane.tsx');
    // Row menu (download, rename, move, trash, restore, process, new version).
    expect(grid).toContain('RowActions');
    expect(list).toContain('RowActions');
    // Search with folder/space scope and pager, trash view, uploads, selection batch actions.
    for (const needle of [
      'TeamCatalog',
      'TrashView',
      'uploadTeamFile',
      'onCreateTaskFromSelection',
      'onProcessSelection',
      'KindFilterBar'
    ]) {
      expect(shell, needle).toContain(needle);
    }
    // Landing render state and the way into the full viewer.
    expect(pane).toContain('landingRender');
    expect(pane).toContain('teamExplorerPreviewOpen');
  });
});
