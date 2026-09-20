// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WEB_TOOL_REQUIREMENTS } from '@video-compressor/shared';

// The registry imports the real tool pages; stub them (and the agent context)
// so HomePage renders without a live agent or heavy page modules.
vi.mock('../apps/web/src/App.js', async () => {
  const ReactModule = await import('react');
  return {
    default: () => null,
    Header: () => ReactModule.createElement('header'),
    Onboarding: () => null
  };
});
vi.mock('../apps/web/src/landing/LandingOptimizerPage.js', () => ({ default: () => null }));
vi.mock('../apps/web/src/landing-preview/LandingPreviewPage.js', () => ({ default: () => null }));
vi.mock('../apps/web/src/transcription/TranscriptionPage.js', () => ({ default: () => null }));
// Steerable rather than fixed: feature 016 needs to ask what the home screen
// does when the local app is closed, which is the whole question for a tool
// that does not use it.
const agent = vi.hoisted(() => ({
  connection: 'connected' as string,
  capabilities: ['landing'] as string[],
  toolAvailable: vi.fn((_tool: string) => true)
}));
vi.mock('../apps/web/src/AgentContext.js', () => ({
  useAgent: () => ({
    connection: agent.connection,
    capabilities: agent.capabilities,
    connectedOnce: agent.connection === 'connected',
    toolAvailable: agent.toolAvailable,
    reconnect: vi.fn()
  })
}));
// The setup dialog is a heavy component with its own release plumbing; what
// matters here is only whether the home screen decided to show one.
vi.mock('../apps/web/src/components/LocalAppDialog.js', () => ({
  default: ({ tool }: { tool: string }) => `setup-dialog:${tool}`
}));
vi.mock('../apps/web/src/analytics/service.js', () => ({
  analytics: { track: vi.fn(), setLocale: vi.fn() }
}));

import HomePage from '../apps/web/src/HomePage';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import type { TeamContextSnapshot } from '../apps/web/src/api/team';
import { catalogueTools, routeKind, toolByPath, webTools } from '../apps/web/src/lib/tool-registry';
import { featureFlags } from '../apps/web/src/lib/feature-flags';
import { translate } from '../apps/web/src/i18n';
import { markAgentSeen } from '../apps/web/src/api/pairing-token';
import { teamApi } from '../apps/web/src/api/team';

/**
 * The home reads the reader's spaces from the provider every signed-in page
 * sits in. Given here with a fixed list and no client, so nothing is fetched
 * and no realtime channel is opened.
 */
function renderHome(
  navigate: (path: string) => void = () => {},
  teams: TeamContextSnapshot[] = []
) {
  return render(
    <TeamProvider initialTeams={teams} realtime={false}>
      <HomePage navigate={navigate} />
    </TeamProvider>
  );
}

function space(id: string, name: string, role: TeamContextSnapshot['role']): TeamContextSnapshot {
  return {
    id,
    name,
    role,
    permissions: {} as TeamContextSnapshot['permissions'],
    connectionState: 'connected'
  } as TeamContextSnapshot;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('language', 'en');
  agent.connection = 'connected';
  agent.capabilities = ['landing'];
  agent.toolAvailable.mockClear();
  agent.toolAvailable.mockImplementation(() => true);
  // The workspace opens gradually, and the home screen asks whether this reader is inside the
  // gate. Inside, unless a test says otherwise; nothing here should reach the network.
  vi.spyOn(teamApi, 'canAccessTeamWorkspace').mockResolvedValue(true);
  vi.spyOn(teamApi, 'listMyInvitations').mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('web tool registry', () => {
  it('registers the expected tools with their routes', () => {
    // Declaration order is the reading order on the home screen: the two video
    // tools, then the text they make, then the landing pair with the browser
    // tool between them.
    expect(webTools.map(tool => ({ id: tool.id, path: tool.path }))).toEqual([
      { id: 'compressor', path: '/compressor' },
      { id: 'stitcher', path: '/stitcher' },
      { id: 'transcription', path: '/transcription' },
      { id: 'landingOptimizer', path: '/landing-optimizer' },
      { id: 'twoFactor', path: '/2fa' },
      { id: 'landingPreview', path: '/landing-preview' }
    ]);
    // Every tool that needs the local app maps onto the shared agent contract.
    // A browser tool deliberately does not — see the last describe in this file.
    for (const tool of webTools) {
      if (tool.runtime !== 'agent') continue;
      expect(WEB_TOOL_REQUIREMENTS[tool.id]).toBeDefined();
    }
  });

  it('shows what is ready first, then beta, then what is not there yet', () => {
    const rank = { available: 0, beta: 1, 'coming-soon': 2, 'in-development': 3 } as const;
    const shown = catalogueTools.map(tool => rank[tool.status]);
    expect(shown).toEqual([...shown].sort((a, b) => a - b));
    // Every tool is still in it, and equal standing keeps declaration order —
    // the sort carries the catalogue, it does not filter it.
    expect(catalogueTools).toHaveLength(webTools.length);
    const available = catalogueTools.filter(tool => tool.status === 'available');
    expect(available.map(tool => tool.id)).toEqual(
      webTools.filter(tool => tool.status === 'available').map(tool => tool.id)
    );
  });

  it('keeps tool paths unique and rooted', () => {
    const paths = webTools.map(tool => tool.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      expect(path.startsWith('/')).toBe(true);
    }
  });

  it('classifies registry paths and leaves everything else on home', () => {
    for (const tool of webTools) {
      expect(routeKind(tool.path)).toBe(tool.analyticsId);
      expect(toolByPath(tool.path)?.id).toBe(tool.id);
    }
    expect(routeKind('/')).toBe('home');
    expect(routeKind('/unknown')).toBe('home');
    expect(toolByPath('/unknown')).toBeUndefined();
  });

  it('follows the development-warning flag, and nothing else', () => {
    // Every tool in the catalogue is finished now — transcription carried a
    // presentation-only "beta" label and the stitcher the acknowledgement gate,
    // and both are released. What is left is one rule: a tool is ready unless
    // its flag says it is still being built.
    for (const tool of webTools) {
      const protectedFlag = tool.featureFlag ? featureFlags[tool.featureFlag].protected : false;
      expect(tool.status).toBe(protectedFlag ? 'in-development' : 'available');
    }
  });

  it('renders a home-page tile for every registered tool, and the tile is a link', () => {
    renderHome();
    for (const tool of webTools) {
      // The tile's title is the link, so its accessible name is the tool's name
      // and nothing else; the caption describes it rather than being part of it.
      const link = screen.getByRole('link', { name: translate('en', tool.labelKey) });
      expect(link.getAttribute('href')).toBe(tool.path);
      expect(link.closest('h4')).toBeTruthy();
      expect(screen.getByText(translate('en', tool.captionKey))).toBeTruthy();
    }
    // No button inside a tile, and no primary action on the page at all.
    expect(document.querySelectorAll('.home-tile button')).toHaveLength(0);
    expect(document.querySelectorAll('.ui-color-primary')).toHaveLength(0);
  });

  it('draws one row per group, in reading order', async () => {
    renderHome();
    // Spaces arrive with the answer to "may this reader have one", so the row order is read
    // once that has landed.
    await screen.findByText(translate('en', 'teamSpaceEmptyAction'));
    const headings = screen
      .getAllByRole('heading', { level: 3 })
      .map(heading => heading.textContent);
    expect(headings).toEqual([
      translate('en', 'teamWorkspace'),
      translate('en', 'homeGroupVideo'),
      translate('en', 'homeGroupLanding'),
      translate('en', 'homeGroupOther')
    ]);
  });

  it('leaves "connected" to the header, and says nothing per tile', () => {
    renderHome();
    // The fact is still in the tree for a reader that asks; it is not drawn twice.
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('status', { hidden: true }).textContent).toBe(
      translate('en', 'agentConnected')
    );
    expect(screen.queryByText(translate('en', 'agentRequired'))).toBeNull();
    expect(screen.queryByRole('button', { name: translate('en', 'homeHowToStart') })).toBeNull();
  });

  it('offers the first space to someone who has none, without requiring the local agent', async () => {
    agent.connection = 'disconnected';
    const navigate = vi.fn();
    renderHome(navigate);

    const create = await screen.findByRole('link', {
      name: translate('en', 'teamSpaceEmptyAction')
    });
    expect(create.getAttribute('href')).toBe('/team?new=1');
    fireEvent.click(create);
    expect(navigate).toHaveBeenCalledWith('/team?new=1');
  });

  it('tells somebody outside the gate, after the tools that do work (024)', async () => {
    // The workspace opens in batches, and `create_team` answers a stranger with a refusal. The
    // home screen used to lead with "create your first space" for everybody, so the first thing
    // a new customer saw was a button that ends at a waiting list.
    vi.mocked(teamApi.canAccessTeamWorkspace).mockResolvedValue(false);
    renderHome();

    // The tile is the gate it opens: same title, same sentence, and the button it will offer.
    expect(await screen.findByText(translate('en', 'teamWorkspaceGateTitle'))).toBeTruthy();
    const waitlist = screen.getByRole('link', {
      name: new RegExp(translate('en', 'teamWorkspaceGateTitle'), 'u')
    });
    expect(waitlist.getAttribute('href')).toBe('/team?all=1');
    expect(
      screen.queryByRole('link', { name: translate('en', 'teamSpaceEmptyAction') })
    ).toBeNull();
    const sections = [...document.querySelectorAll('.home-section, .home-tools')];
    expect(sections.at(-1)?.classList.contains('home-section--spaces')).toBe(true);
  });

  it('lists the spaces themselves, the remembered one first, each at its own address', () => {
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';
    localStorage.setItem('wishly.active-team.v1', second);
    const navigate = vi.fn();
    renderHome(navigate, [space(first, 'Nutra', 'owner'), space(second, 'Gambling', 'editor')]);

    const links = screen
      .getAllByRole('link')
      .filter(link => link.getAttribute('href')?.startsWith('/team/'));
    expect(links.map(link => link.textContent)).toEqual(['Gambling', 'Nutra']);
    expect(screen.getByText(translate('en', 'homeSpaceLast'))).toBeTruthy();
    expect(screen.getByText(translate('en', 'teamRoleEditor'))).toBeTruthy();

    fireEvent.click(links[0]);
    expect(navigate).toHaveBeenCalledWith(`/team/${second}`);
    // The way to everything else — the lobby — is in the row's heading.
    expect(
      screen.getByRole('link', { name: translate('en', 'homeAllSpaces') }).getAttribute('href')
    ).toBe('/team?all=1');
  });

  it('leaves a modified click to the browser', () => {
    const navigate = vi.fn();
    renderHome(navigate);
    const link = screen.getByRole('link', { name: translate('en', 'twoFactorNotebook') });
    fireEvent.click(link, { metaKey: true });
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('a tool that runs in the browser', () => {
  /**
   * Feature 016. The 2FA notebook is the first tool that needs nothing from the
   * local app, and the registry had no way to say so: every tool was gated on a
   * connected, contract-compatible agent, and `toolAvailable` takes a
   * `SotyToolId` — an id from the signed release contract.
   *
   * These cases pin the two halves of that. The behaviour: with the app closed,
   * a browser tool opens and an agent tool does not. And the release posture:
   * a browser tool stays out of `WEB_TOOL_REQUIREMENTS`, because that map is
   * byte-compared against the published `stable.json`, so a key there would
   * block `deploy:web` on an agent release this tool has no stake in.
   */
  const browserTools = webTools.filter(tool => tool.runtime === 'browser');

  /** A tile is followed through its title, which is a link named after the tool. */
  function tileFor(labelKey: Parameters<typeof translate>[1]): HTMLElement {
    return screen.getByRole('link', { name: translate('en', labelKey) });
  }

  it('has at least one, or these cases prove nothing', () => {
    expect(browserTools.length).toBeGreaterThan(0);
  });

  it('stays out of the signed agent contract', () => {
    for (const tool of browserTools) {
      expect(tool.id in WEB_TOOL_REQUIREMENTS).toBe(false);
      expect(tool.capability).toBeUndefined();
    }
  });

  it('opens with the local app closed, without asking the agent anything', () => {
    agent.connection = 'disconnected';
    agent.toolAvailable.mockImplementation(() => false);
    const navigate = vi.fn();

    for (const tool of browserTools) {
      if (tool.featureFlag)
        localStorage.setItem(`wishly.feature-unlock.${tool.featureFlag}`, 'true');
    }
    renderHome(navigate);

    for (const tool of browserTools) {
      fireEvent.click(tileFor(tool.labelKey));
      expect(navigate).toHaveBeenCalledWith(tool.path);
      // And it does not claim to need what it never calls.
      expect(tileFor(tool.labelKey).getAttribute('aria-describedby')).not.toMatch(/-note/);
    }
    // Not merely "it navigated anyway": the agent was never consulted at all.
    for (const call of agent.toolAvailable.mock.calls) {
      expect(browserTools.map(tool => tool.id)).not.toContain(call[0]);
    }
  });

  it('leaves an agent tool waiting for the local app, as before', () => {
    agent.connection = 'disconnected';
    agent.toolAvailable.mockImplementation(() => false);
    const navigate = vi.fn();

    const agentTool = webTools.find(tool => tool.runtime === 'agent' && !tool.featureFlag);
    const target = agentTool ?? webTools.find(tool => tool.runtime === 'agent')!;
    if (target.featureFlag) {
      localStorage.setItem(`wishly.feature-unlock.${target.featureFlag}`, 'true');
    }
    renderHome(navigate);

    // The tile says why before anyone presses it …
    const described = tileFor(target.labelKey).getAttribute('aria-describedby') ?? '';
    const note = document.getElementById(described.split(' ').pop() ?? '');
    expect(note?.textContent).toBe(translate('en', 'agentRequired'));

    // … and pressing it answers with the setup dialog, in place, not with an
    // empty tool page.
    fireEvent.click(tileFor(target.labelKey));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByText(`setup-dialog:${target.id}`)).toBeTruthy();
  });

  it('puts the way to start the local app beside its state, once', () => {
    agent.connection = 'not_installed_or_not_running';
    agent.toolAvailable.mockImplementation(() => false);
    // This browser has met the app before, so this is "it is closed", not
    // onboarding: the badge and the link, and no install panel.
    markAgentSeen();
    renderHome();

    const how = screen.getAllByRole('button', { name: translate('en', 'homeHowToStart') });
    expect(how).toHaveLength(1);
    fireEvent.click(how[0]);
    expect(screen.getByText(/^setup-dialog:/)).toBeTruthy();
  });
});
