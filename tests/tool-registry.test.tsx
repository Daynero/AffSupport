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
vi.mock('../apps/web/src/AgentContext.js', () => ({
  useAgent: () => ({
    connection: 'connected',
    capabilities: ['landing'],
    toolAvailable: () => true,
    reconnect: vi.fn()
  })
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
      { id: 'transcription', path: '/transcription' }
    ]);
    // Every registered tool maps onto the shared agent contract.
    for (const tool of webTools) {
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
