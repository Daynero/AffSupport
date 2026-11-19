import { describe, expect, it } from 'vitest';
import {
  MOTION_REGISTRY,
  OVERLAY_KINDS,
  SCREEN_KINDS,
  TOOL_PATHS,
  motionBetween,
  screenOf
} from '../apps/web/src/lib/motion-registry';
import { NAV_SCREENS } from '../apps/web/src/analytics/events';
import { webTools } from '../apps/web/src/lib/tool-registry';
import { TEAM_SECTIONS, buildTeamRoute, emptyTeamRouteQuery } from '../apps/web/src/team/routes';

describe('transition registry (058, FR-001/FR-026)', () => {
  it('has exactly one entry per screen kind, and analytics knows the same screens', () => {
    expect(MOTION_REGISTRY.map(entry => entry.screen).sort()).toEqual([...SCREEN_KINDS].sort());
    expect([...NAV_SCREENS]).toEqual([...SCREEN_KINDS]);
  });

  it('lists the same tool paths as the tool registry', () => {
    expect([...TOOL_PATHS].sort()).toEqual(webTools.map(tool => tool.path).sort());
  });

  it('maps every tool, every space section and every fixed page to a known screen', () => {
    for (const tool of webTools) expect(screenOf(tool.path)).toBe('tool');
    for (const section of TEAM_SECTIONS) {
      const route = buildTeamRoute({ spaceId: 'space-1', section, query: emptyTeamRouteQuery() });
      expect(screenOf(route)).toBe(`team_${section}`);
    }
    expect(screenOf('/')).toBe('tools_home');
    expect(screenOf('/account')).toBe('account');
    expect(screenOf('/admin')).toBe('admin');
    expect(screenOf('/team')).toBe('team_lobby');
    expect(screenOf('/team?all=1')).toBe('team_lobby');
    expect(screenOf('/team/space-1/explorer?trash=1')).toBe('team_trash');
    expect(screenOf('/privacy')).toBe('public_legal');
    expect(screenOf('/terms')).toBe('public_legal');
    expect(screenOf('/login')).toBe('auth');
    expect(screenOf('/somewhere-else')).toBe('other');
  });

  it('gives every lazily loaded workspace section a skeleton', () => {
    for (const section of ['explorer', 'tasks', 'launches', 'accounts'] as const) {
      const entry = MOTION_REGISTRY.find(item => item.screen === `team_${section}`);
      expect(entry?.motion).toBe('section');
      expect(entry?.skeleton).not.toBeNull();
    }
  });

  it('covers every overlay surface of the inventory', () => {
    expect(OVERLAY_KINDS.map(kind => kind.kind)).toEqual(
      expect.arrayContaining(['modal', 'drawer', 'popover', 'dropdown_menu'])
    );
  });
});

describe('motionBetween', () => {
  it('reads another section of the same space as a section move', () => {
    expect(motionBetween('/team/s/explorer', '/team/s/tasks')).toBe('section');
    expect(motionBetween('/team/s/tasks', '/team/s/explorer?trash=1')).toBe('section');
  });

  it('reads the same section with another query as no move', () => {
    expect(motionBetween('/team/s/explorer', '/team/s/explorer?folder=1')).toBe('none');
    expect(motionBetween('/team/s/tasks', '/team/s/tasks?task=7')).toBe('none');
    expect(motionBetween('/team/s/explorer', '/team/s/files')).toBe('none');
  });

  it('reads another space, another area or the boundary as a page move', () => {
    expect(motionBetween('/team/a/explorer', '/team/b/explorer')).toBe('page');
    expect(motionBetween('/', '/compressor')).toBe('page');
    expect(motionBetween('/compressor', '/team/s/explorer')).toBe('page');
    expect(motionBetween('/team', '/team/s/explorer')).toBe('page');
  });

  it('reads a query or hash change on the same path as no move', () => {
    expect(motionBetween('/account', '/account?tab=2')).toBe('none');
    expect(motionBetween('/compressor', '/compressor#x')).toBe('none');
  });
});
