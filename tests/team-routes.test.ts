import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SECTION,
  TEAM_SECTIONS,
  buildTeamRoute,
  emptyTeamRouteQuery,
  parseTeamRoute,
  teamResolverRoute
} from '../apps/web/src/team/routes';

/**
 * The route model is the one place that decides what a team URL *means*, so
 * these tests are the contract for `contracts/routes-and-navigation.md`: URL is
 * truth, refresh restores the view, and a hand-edited address always lands
 * somewhere explainable instead of throwing.
 */
describe('parseTeamRoute', () => {
  it('ignores routes outside /team', () => {
    expect(parseTeamRoute('/')).toBeNull();
    expect(parseTeamRoute('/account')).toBeNull();
    expect(parseTeamRoute('/teams/abc')).toBeNull();
    // A prefix match must not swallow a sibling path that merely starts the same.
    expect(parseTeamRoute('/teamwork')).toBeNull();
  });

  it('reads the bare resolver address and its Drive return', () => {
    expect(parseTeamRoute('/team')).toEqual({ kind: 'resolver', driveReturn: null });
    expect(parseTeamRoute('/team/')).toEqual({ kind: 'resolver', driveReturn: null });
    expect(parseTeamRoute('/team?drive=folder-1')).toEqual({
      kind: 'resolver',
      driveReturn: 'folder-1'
    });
  });

  it('treats a bare space address as Files, the canonical default', () => {
    const route = parseTeamRoute('/team/space-1');
    expect(route).toMatchObject({ kind: 'space', spaceId: 'space-1', section: 'files' });
  });

  it('parses every declared section', () => {
    for (const section of TEAM_SECTIONS) {
      const route = parseTeamRoute(`/team/space-1/${section}`);
      expect(route).toMatchObject({ kind: 'space', section });
    }
  });

  it('degrades an unrecognized section to Files rather than failing', () => {
    expect(parseTeamRoute('/team/space-1/bogus')).toMatchObject({
      kind: 'space',
      spaceId: 'space-1',
      section: DEFAULT_SECTION
    });
  });

  it('carries an unrecognized space id through verbatim', () => {
    // The neutral no-access screen is the resolver's job; parsing must not
    // pre-judge, or "absent" and "denied" would stop being indistinguishable.
    expect(parseTeamRoute('/team/not-a-uuid')).toMatchObject({
      kind: 'space',
      spaceId: 'not-a-uuid'
    });
  });

  it('restores the query half of the view state', () => {
    const route = parseTeamRoute('/team/space-1?q=banner&folder=folder-9');
    expect(route).toMatchObject({
      kind: 'space',
      query: { q: 'banner', folderId: 'folder-9', taskId: null }
    });
  });

  it('restores an open task over the Tasks section', () => {
    expect(parseTeamRoute('/team/space-1/tasks?task=task-7')).toMatchObject({
      query: { taskId: 'task-7' }
    });
  });

  it('restores repeated filter params', () => {
    const route = parseTeamRoute('/team/space-1?geo=US&geo=DE&lang=en&kind=file');
    expect(route).toMatchObject({
      query: { filters: { geo: ['US', 'DE'], language: ['en'], kind: ['file'] } }
    });
  });

  it('drops filter values the search contract would reject', () => {
    const route = parseTeamRoute('/team/space-1?geo=NOT_A_GEO&kind=made-up');
    expect(route).toMatchObject({ query: { filters: { geo: [], kind: [] } } });
  });

  it('keeps a comma inside a free-text offer filter', () => {
    const route = parseTeamRoute(`/team/space-1?offer=${encodeURIComponent('acme, inc')}`);
    expect(route).toMatchObject({ query: { filters: { offer: ['acme, inc'] } } });
  });

  it('ignores the hash and blank query values', () => {
    expect(parseTeamRoute('/team/space-1?q=&folder=#anchor')).toMatchObject({
      query: { q: '', folderId: null }
    });
  });
});

describe('buildTeamRoute', () => {
  it('omits the suffix for the canonical Files section', () => {
    expect(buildTeamRoute({ spaceId: 'space-1' })).toBe('/team/space-1');
    expect(buildTeamRoute({ spaceId: 'space-1', section: 'files' })).toBe('/team/space-1');
  });

  it('writes the suffix for every other section', () => {
    expect(buildTeamRoute({ spaceId: 'space-1', section: 'tasks' })).toBe('/team/space-1/tasks');
    expect(buildTeamRoute({ spaceId: 'space-1', section: 'trash' })).toBe('/team/space-1/trash');
  });

  it('drops query state the section cannot act on', () => {
    // One view, one address: a Tasks link carrying a catalog filter would make
    // Back walk through addresses that render identically.
    const route = buildTeamRoute({
      spaceId: 'space-1',
      section: 'tasks',
      query: { q: 'banner', folderId: 'folder-9', taskId: 'task-7' }
    });
    expect(route).toBe('/team/space-1/tasks?task=task-7');
  });

  it('round-trips a Files view with search, filters and position', () => {
    const built = buildTeamRoute({
      spaceId: 'space-1',
      query: {
        q: 'banner',
        filters: { ...emptyTeamRouteQuery().filters, geo: ['US'], language: ['en'] },
        folderId: 'folder-9'
      }
    });
    const parsed = parseTeamRoute(built);
    expect(parsed).toMatchObject({
      kind: 'space',
      spaceId: 'space-1',
      section: 'files',
      query: { q: 'banner', folderId: 'folder-9', filters: { geo: ['US'], language: ['en'] } }
    });
  });

  it('round-trips every section through the parser', () => {
    for (const section of TEAM_SECTIONS) {
      const parsed = parseTeamRoute(buildTeamRoute({ spaceId: 'space-1', section }));
      expect(parsed).toMatchObject({ section });
    }
  });
});

describe('teamResolverRoute', () => {
  it('is the bare address where entry decisions are made', () => {
    expect(teamResolverRoute()).toBe('/team');
    expect(parseTeamRoute(teamResolverRoute())).toMatchObject({ kind: 'resolver' });
  });
});
