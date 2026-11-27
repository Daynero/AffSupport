import { useState } from 'react';
import { SOTY_LOAD_CHANNEL, sotyLoadSupported, type SotyLoad } from '@video-compressor/shared';
import { useAgentEventStream } from '../api/useAgentEventStream';
import { useOptionalAgent } from '../AgentContext';

/**
 * How hard Soty itself is working the computer, live, for the header's power button and the
 * line in its panel — one reading for both, so the two can never disagree.
 *
 * Asked for only when the connected agent publishes Soty's own figure (`machineLoad` 2 in
 * its contract) and offers the multiplexed stream. An agent at revision 1 publishes the
 * whole computer's load on the same channel; it is never subscribed to, and the button
 * stays the bolt. The stream parks when the tab is hidden, which is also what stops the
 * agent measuring: nobody looking costs nothing on either side.
 *
 * `supported` says which of two worlds the header is in, so the panel never falls back to
 * the throttle's own figure while this one is merely warming up — that fallback is exactly
 * how the button and the sentence beneath it came to say different things. `load` is null
 * whenever there is no figure to show: no agent, an older one, or one still warming up.
 */
export interface SotyLoadView {
  supported: boolean;
  load: SotyLoad | null;
}

export function useSotyLoad(): SotyLoadView {
  const agent = useOptionalAgent();
  const connected = agent?.connection === 'connected';
  const enabled = Boolean(
    connected &&
    agent?.capabilities?.includes('event-stream') &&
    sotyLoadSupported(agent.toolContracts)
  );
  const [load, setLoad] = useState<SotyLoad | null>(null);

  useAgentEventStream<SotyLoad>({
    url: null,
    channel: SOTY_LOAD_CHANNEL,
    multiplexed: true,
    enabled,
    onMessage: setLoad,
    // A figure from a connection that has gone is not a figure about Soty now.
    onDisconnect: () => setLoad(null)
  });

  return { supported: enabled, load: enabled ? load : null };
}
