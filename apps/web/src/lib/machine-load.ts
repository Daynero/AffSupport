import { useState } from 'react';
import {
  MACHINE_LOAD_CHANNEL,
  machineLoadSupported,
  type MachineLoad
} from '@video-compressor/shared';
import { useAgentEventStream } from '../api/useAgentEventStream';
import { useOptionalAgent } from '../AgentContext';

/**
 * How busy the whole computer is, live, for the header's power button.
 *
 * Asked for only when the connected agent says it publishes it (`machineLoad` in its
 * contract) and offers the multiplexed stream — so an older agent is never asked, and the
 * button stays the bolt it was. The stream parks when the tab is hidden, which is also what
 * stops the agent measuring: nobody looking costs nothing on either side.
 *
 * Null whenever there is no figure to show: no agent, an older one, or one still warming up.
 */
export function useMachineLoad(): MachineLoad | null {
  const agent = useOptionalAgent();
  const connected = agent?.connection === 'connected';
  const enabled = Boolean(
    connected &&
    agent?.capabilities?.includes('event-stream') &&
    machineLoadSupported(agent.toolContracts)
  );
  const [load, setLoad] = useState<MachineLoad | null>(null);

  useAgentEventStream<MachineLoad>({
    url: null,
    channel: MACHINE_LOAD_CHANNEL,
    multiplexed: true,
    enabled,
    onMessage: setLoad,
    // A figure from a connection that has gone is not a figure about this machine now.
    onDisconnect: () => setLoad(null)
  });

  return enabled ? load : null;
}
