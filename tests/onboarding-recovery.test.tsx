// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AgentContextOverride, type AgentContextValue } from '../apps/web/src/AgentContext';
import { markAgentSeen } from '../apps/web/src/api/client';
import { Onboarding } from '../apps/web/src/App';
import { translate, type TranslationKey } from '../apps/web/src/i18n';
import { emptyQueueState } from './web-auth-helpers';
import { fakeAgentValue } from './support/fake-agent';
import { expectPrimaryAction } from './support/design-system';

const t = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate('uk', key, values);

function agentValue(): AgentContextValue {
  return fakeAgentValue({
    connection: 'not_installed_or_not_running',
    state: emptyQueueState,
    connectedOnce: false,
    agentVersion: null,
    agentBuildId: null,
    agentChannel: null,
    agentApiVersion: null,
    toolAvailable: () => false,
    toolAvailability: () => 'disconnected',
    teamWorkspaceAvailable: false,
    teamWorkspaceAvailability: 'disconnected'
  });
}

function renderOnboarding(
  state: AgentContextValue['connection'],
  overrides: Partial<AgentContextValue> = {}
) {
  return render(
    <AgentContextOverride value={{ ...agentValue(), ...overrides }}>
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
    expectPrimaryAction(install);
    expect(screen.queryByRole('link', { name: 'Відкрити Soty' })).toBeNull();
  });

  it('leads with opening Soty once this browser has met the Agent', () => {
    // The likeliest reading of a failed probe in a browser that has already
    // paired is not "it was uninstalled" — it is a browser that will not let
    // this page look at loopback at all.
    markAgentSeen();

    renderOnboarding('not_installed_or_not_running');

    const open = screen.getByRole('link', { name: 'Відкрити Soty' });
    expectPrimaryAction(open);
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

  it('leads to the Agent copy of this very page when the browser blocks loopback', () => {
    // "Try again" asks for the same permission that was just refused, so it is
    // gone; opening the Agent's own copy is the one action that can succeed,
    // and it lands on the page the person was on (032 FR-016). The download
    // stays, quieter, for the one person whose Agent really is missing.
    history.replaceState(null, '', '/stitcher?tab=queue');

    renderOnboarding('connection_blocked');

    const open = screen.getByRole('link', { name: 'Відкрити в Soty' });
    expectPrimaryAction(open);
    expect(open.getAttribute('target')).toBeNull();
    expect(open.getAttribute('href')).toBe(
      'http://127.0.0.1:43120/local?to=%2Fstitcher%3Ftab%3Dqueue'
    );
    expect(screen.getByText('Браузер блокує з’єднання з Soty')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Встановити Soty' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Спробувати знову' })).toBeNull();
  });

  it('re-pairs through the local app when the account check is blocked', () => {
    history.replaceState(null, '', '/tools/compressor');

    renderOnboarding('entitlement_blocked');

    const recover = screen.getByRole('link', { name: 'Перепідключити через Soty' });
    expectPrimaryAction(recover);
    expect(recover.getAttribute('href')).toBe(
      'http://127.0.0.1:43120/local?to=%2Ftools%2Fcompressor'
    );
    expect(screen.getByRole('button', { name: 'Спробувати знову' })).toBeTruthy();
  });

  it('says the account check could not be reached, and keeps trying on its own', () => {
    // A server that could not be reached is not a server that said no: the
    // panel names the reason and offers a retry, not a re-pairing (032 FR-015).
    renderOnboarding('entitlement_blocked', { reason: 'account_check_unavailable' });

    expect(
      screen.getByText('Онлайн-перевірка акаунта зараз недоступна; спробуємо ще раз самі')
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Спробувати знову' })).toBeTruthy();
  });
});
