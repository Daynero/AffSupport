// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AgentContextOverride, type AgentContextValue } from '../apps/web/src/AgentContext';
import { markAgentSeen } from '../apps/web/src/api/client';
import { Onboarding } from '../apps/web/src/App';
import { translate, type TranslationKey } from '../apps/web/src/i18n';
import { emptyQueueState } from './web-auth-helpers';

const t = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate('uk', key, values);

function agentValue(): AgentContextValue {
  return {
    connection: 'not_installed_or_not_running',
    state: emptyQueueState,
    setState: vi.fn(),
    connectedOnce: false,
    agentVersion: null,
    agentBuildId: null,
    agentChannel: null,
    agentApiVersion: null,
    capabilities: [],
    toolContracts: {},
    releaseManifest: { status: 'unavailable', manifest: null },
    toolAvailable: () => false,
    reconnect: vi.fn()
  };
}

function renderOnboarding(state: AgentContextValue['connection']) {
  return render(
    <AgentContextOverride value={agentValue()}>
      <Onboarding state={state} help={false} setHelp={vi.fn()} connect={vi.fn()} t={t} />
    </AgentContextOverride>
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('language', 'uk');
  history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the panel shown when the page cannot reach the Agent', () => {
  it('offers the installation to a browser with no history of the Agent', () => {
    renderOnboarding('not_installed_or_not_running');

    const install = screen.getByRole('link', { name: 'Встановити Soty' });
    expect(install.className).toContain('button-primary');
    expect(screen.queryByRole('link', { name: 'Відкрити Soty' })).toBeNull();
  });

  it('leads with opening Soty once this browser has met the Agent', () => {
    // The likeliest reading of a failed probe in a browser that has already
    // paired is not "it was uninstalled" — it is a browser that will not let
    // this page look at loopback at all.
    markAgentSeen();

    renderOnboarding('not_installed_or_not_running');

    const open = screen.getByRole('link', { name: 'Відкрити Soty' });
    expect(open.className).toContain('button-primary');
    expect(open.getAttribute('href')).toBe('http://127.0.0.1:43120/local');
    expect(screen.getByRole('heading', { name: 'Відкрийте Soty, щоб продовжити' })).toBeTruthy();
    // Never a dead end for the one person this guesses wrong about.
    expect(
      screen.getByRole('link', { name: 'Немає Soty на цьому комп’ютері? Встановити' })
    ).toBeTruthy();
  });

  it('carries the tool the user was on into the Agent copy', () => {
    markAgentSeen();
    history.replaceState(null, '', '/tools/transcription');

    renderOnboarding('not_installed_or_not_running');

    expect(screen.getByRole('link', { name: 'Відкрити Soty' }).getAttribute('href')).toBe(
      'http://127.0.0.1:43120/local?to=%2Ftools%2Ftranscription'
    );
  });

  it('puts opening ahead of retrying when the browser has denied local access', () => {
    // "Try again" asks for the same permission that was just refused; opening
    // the Agent's own copy is the only action that can actually succeed.
    renderOnboarding('connection_blocked');

    const open = screen.getByRole('link', { name: 'Відкрити Soty' });
    expect(open.className).toContain('button-primary');
    expect(open.getAttribute('target')).toBeNull();
    expect(screen.getByText('Відкрийте Soty, щоб продовжити')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Спробувати знову' })).toBeTruthy();
  });
});
