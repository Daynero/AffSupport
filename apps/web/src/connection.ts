import {
  MAX_SUPPORTED_AGENT_API_VERSION,
  MIN_SUPPORTED_AGENT_API_VERSION
} from '@video-compressor/shared';

export type ConnectionState =
  | 'checking'
  | 'not_installed_or_not_running'
  | 'connecting'
  | 'connected'
  | 'agent_update_required'
  | 'web_update_required'
  | 'connection_blocked'
  | 'disconnected';
export const MIN_SUPPORTED_API_VERSION = MIN_SUPPORTED_AGENT_API_VERSION;
export const MAX_SUPPORTED_API_VERSION = MAX_SUPPORTED_AGENT_API_VERSION;
export function versionState(apiVersion: number): ConnectionState {
  if (!Number.isInteger(apiVersion) || apiVersion < 0) return 'agent_update_required';
  if (apiVersion < MIN_SUPPORTED_API_VERSION) return 'agent_update_required';
  if (apiVersion > MAX_SUPPORTED_API_VERSION) return 'web_update_required';
  return 'connected';
}
export function pairingPath(agentOrigin: string, pageOrigin: string) { return agentOrigin === pageOrigin ? '/local' : '/pair'; }

export function agentFetchOptions(agentOrigin: string, pageOrigin: string): RequestInit {
  if (agentOrigin === pageOrigin) return {};
  const hostname = new URL(agentOrigin).hostname.toLowerCase();
  // Let the browser classify literal loopback addresses itself. Chrome 145+ separates
  // "loopback" from "local"; declaring targetAddressSpace: "local" for 127.0.0.1
  // makes the request fail before it can reach the Agent or show the permission prompt.
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]') return {};
  return { targetAddressSpace: 'local' } as RequestInit;
}

export async function failureState(): Promise<ConnectionState> {
  const permissions = navigator.permissions as Permissions & { query(descriptor: { name: string }): Promise<PermissionStatus> };
  // Chrome 145 split the old permission. Keep the alias fallback for older versions.
  for (const name of ['loopback-network', 'local-network-access']) {
    try {
      const status = await permissions.query({ name });
      if (status.state === 'denied') return 'connection_blocked';
    } catch { /* unsupported permission name/API */ }
  }
  return 'not_installed_or_not_running';
}
