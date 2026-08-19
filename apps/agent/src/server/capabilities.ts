import { AGENT_CAPABILITIES, type AgentCapability } from '@video-compressor/shared';
import { capabilities, type PlatformCapabilities } from '../platform/platform.js';

/**
 * Which host-OS mechanism each advertised capability depends on. Capabilities
 * absent from this map are platform-neutral and always advertised.
 *
 * This is the single place that decides what the agent claims it can do: the
 * `/health` payloads, the pairing handshake, and the route guards all read the
 * result, so a capability can never be advertised on a platform that cannot
 * serve it (which is exactly what a static list used to allow).
 */
const PLATFORM_REQUIREMENTS: Partial<Record<AgentCapability, keyof PlatformCapabilities>> = {
  'finder-image-conversion': 'shellContextMenuIntegration',
  'native-file-picker': 'nativeFilePicker'
};

/**
 * Capabilities this agent advertises on the current host, in the stable order
 * of AGENT_CAPABILITIES so the payload is deterministic.
 */
export function advertisedCapabilities(
  platform: PlatformCapabilities = capabilities()
): AgentCapability[] {
  return AGENT_CAPABILITIES.filter(capability => {
    const requirement = PLATFORM_REQUIREMENTS[capability];
    return requirement === undefined || platform[requirement];
  });
}

/** True when the current host advertises `capability`. Route guards use this. */
export function hasCapability(
  capability: AgentCapability,
  platform: PlatformCapabilities = capabilities()
): boolean {
  const requirement = PLATFORM_REQUIREMENTS[capability];
  return requirement === undefined || platform[requirement];
}
