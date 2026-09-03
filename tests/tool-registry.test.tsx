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
import { routeKind, toolByPath, webTools } from '../apps/web/src/lib/tool-registry';
import { featureFlags } from '../apps/web/src/lib/feature-flags';
import { translate } from '../apps/web/src/i18n';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('language', 'en');
  agent.connection = 'connected';
  agent.capabilities = ['landing'];
  agent.toolAvailable.mockClear();
  agent.toolAvailable.mockImplementation(() => true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('web tool registry', () => {
  it('registers the expected tools with their routes', () => {
    expect(webTools.map(tool => ({ id: tool.id, path: tool.path }))).toEqual([
      { id: 'compressor', path: '/compressor' },
      { id: 'landingOptimizer', path: '/landing-optimizer' },
      { id: 'landingPreview', path: '/landing-preview' },
      { id: 'stitcher', path: '/stitcher' },
      { id: 'twoFactor', path: '/2fa' },
      { id: 'transcription', path: '/transcription' }
    ]);
    // Every tool that needs the local app maps onto the shared agent contract.
    // A browser tool deliberately does not — see the last describe in this file.
    for (const tool of webTools) {
      if (tool.runtime !== 'agent') continue;
      expect(WEB_TOOL_REQUIREMENTS[tool.id]).toBeDefined();
    }
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

  it('keeps beta availability independent from the development-warning flag', () => {
    for (const tool of webTools) {
      const protectedFlag = tool.featureFlag ? featureFlags[tool.featureFlag].protected : false;
      const expectedStatus =
        tool.id === 'transcription' ? 'beta' : protectedFlag ? 'in-development' : 'available';
      expect(tool.status).toBe(expectedStatus);
    }
  });

  it('renders a home-page tile for every registered tool', () => {
    render(<HomePage navigate={() => {}} />);
    for (const tool of webTools) {
      expect(
        screen.getByRole('heading', { level: 3, name: translate('en', tool.labelKey) })
      ).toBeTruthy();
      expect(screen.getByText(translate('en', tool.descriptionKey))).toBeTruthy();
    }
  });

  it('routes Team Workspace to its authorization gate without requiring the local agent', () => {
    const navigate = vi.fn();
    render(<HomePage navigate={navigate} />);

    const workspace = screen.getByRole('button', {
      name: translate('en', 'teamWorkspace')
    });
    expect(workspace).toBeTruthy();

    fireEvent.click(workspace);
    expect(navigate).toHaveBeenCalledWith('/team');
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

  /**
   * A tile's accessible name is everything inside it — heading, description,
   * badges, the readiness line — so it is found the way the cases above find
   * one: by its heading, then up to the element that actually takes the click.
   */
  function tileFor(labelKey: Parameters<typeof translate>[1]): HTMLElement {
    const heading = screen.getByRole('heading', { level: 3, name: translate('en', labelKey) });
    const tile = heading.closest('[role="button"]');
    expect(tile).toBeTruthy();
    return tile as HTMLElement;
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
    render(<HomePage navigate={navigate} />);

    for (const tool of browserTools) {
      fireEvent.click(tileFor(tool.labelKey));
      expect(navigate).toHaveBeenCalledWith(tool.path);
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
    render(<HomePage navigate={navigate} />);

    fireEvent.click(tileFor(target.labelKey));
    expect(navigate).not.toHaveBeenCalled();
  });
});
