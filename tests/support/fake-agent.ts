import { createElement, type ReactElement, type ReactNode } from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { QueueState } from '../../packages/shared/src/types.js';
import { AgentContextOverride, type AgentContextValue } from '../../apps/web/src/AgentContext.js';
import { optimalSettings } from '../helpers.js';

/**
 * One fake of the local app, for every interface test.
 *
 * Twenty-three component files mock the agent by hand today, and each mock is a slightly
 * different guess at the same object. That is not a tidiness problem. Two of them assert
 * against a `connection` value the real union does not contain; several omit
 * `connectedOnce`, which is the single field that decides whether a user sees a tool page
 * or a download prompt — so the tests most concerned with the disconnected experience are
 * the ones describing a state the application can never be in.
 *
 * The value here is built from the real `AgentContextValue`, so a field added to the
 * context is a compile error in one place rather than twenty-three silent omissions.
 *
 * Prefer `renderWithAgent`. `AgentContextOverride` is the seam the application already
 * exposes, and using it means the component under test runs its real context plumbing.
 * `fakeAgentModule` exists only for the handful of files that render a tree they do not
 * own and therefore cannot wrap.
 */

/** A queue state with nothing in it — the shape after a fresh connection. */
export function fakeQueueState(overrides: Partial<QueueState> = {}): QueueState {
  return {
    jobs: [],
    running: false,
    tools: { ffmpeg: true, ffprobe: true },
    settings: optimalSettings,
    batch: null,
    warning: null,
    ...overrides
  };
}

/**
 * A complete context value. Every field is populated with what a connected, up-to-date
 * local app would report, so a test overrides only the thing it is about.
 */
export function fakeAgentValue(overrides: Partial<AgentContextValue> = {}): AgentContextValue {
  const state = overrides.state ?? fakeQueueState();
  return {
    connection: 'connected',
    state,
    setState: () => {},
    connectedOnce: true,
    agentVersion: '1.0.3',
    agentBuildId: 'test-build',
    agentChannel: 'stable',
    agentApiVersion: 1,
    capabilities: [],
    toolContracts: {},
    releaseManifest: { status: 'unavailable', manifest: null },
    // Available by default. A test about an unavailable tool says so explicitly, which
    // reads better than every other test having to say the opposite.
    toolAvailable: () => true,
    teamWorkspaceAvailable: true,
    reconnect: () => {},
    ...overrides
  };
}

/**
 * Renders `ui` with a fake local app attached.
 *
 * The replacement for `vi.mock('../apps/web/src/AgentContext.js', …)`. A mocked module
 * replaces the provider as well as the hook, so a component that reads the context through
 * any path the test did not anticipate gets `undefined` instead of a fake — which surfaces
 * as a crash in an unrelated component and is diagnosed as a broken test.
 */
export function renderWithAgent(
  ui: ReactElement,
  agent: Partial<AgentContextValue> = {},
  options: RenderOptions = {}
): RenderResult & { agent: AgentContextValue } {
  const value = fakeAgentValue(agent);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(AgentContextOverride, { value, children });
  return { ...render(ui, { wrapper, ...options }), agent: value };
}

/**
 * The module shape for a `vi.mock` factory, for trees that cannot be wrapped.
 *
 * `read` is called on every access rather than captured once, so a test can change what the
 * fake reports between renders — the disconnect cases need exactly that, and a snapshot
 * taken at mock time cannot express it.
 */
export function fakeAgentModule(read: () => Partial<AgentContextValue>) {
  const value = () => fakeAgentValue(read());
  return {
    useAgent: () => value(),
    useOptionalAgent: () => value(),
    AgentContextOverride,
    // Kept real: a test that mocks the module still renders the provider in some trees, and
    // substituting a pass-through here would silently disable the context for them.
    AgentProvider: ({ children }: { children: ReactNode }) =>
      createElement(AgentContextOverride, { value: value(), children })
  };
}
