import { vi } from 'vitest';
import type { AgentContextValue } from '../../apps/web/src/AgentContext';
import { emptyQueueState } from '../web-auth-helpers';

/**
 * A connected Agent, for suites whose subject is something else entirely.
 *
 * Five files each built this object by hand and named only the four or five
 * fields they cared about. `AgentContextValue` has since grown a build id, a
 * channel, an API version, a tool-contract map and a release-manifest state,
 * and every one of those files went stale at the same moment — invisibly, since
 * they were excluded from the typecheck for exactly this reason.
 *
 * One record, no cast. A field added to the context now breaks here, once.
 */
export function agentContextStub(overrides: Partial<AgentContextValue> = {}): AgentContextValue {
  return {
    connection: 'connected',
    state: emptyQueueState,
    setState: vi.fn(),
    connectedOnce: true,
    agentVersion: '0.4.0',
    agentBuildId: null,
    agentChannel: 'stable',
    agentApiVersion: 1,
    capabilities: [],
    toolContracts: {},
    releaseManifest: { status: 'checking', manifest: null },
    toolAvailable: () => true,
    reconnect: vi.fn(),
    ...overrides
  };
}
