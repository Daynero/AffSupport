import {
  MAX_SUPPORTED_AGENT_API_VERSION,
  MIN_SUPPORTED_AGENT_API_VERSION
} from '@video-compressor/shared';
import { currentBrowserFamily } from './lib/browser';

export type ConnectionState =
  | 'checking'
  | 'not_installed_or_not_running'
  | 'pairing_required'
  | 'connecting'
  | 'connected'
  | 'agent_update_required'
  | 'web_update_required'
  | 'connection_blocked'
  | 'entitlement_blocked'
  | 'disconnected';

/**
 * Why the interface is not simply connected (032 FR-012).
 *
 * `ConnectionState` says which screen to show; this says which sentence. The two used to be
 * one, and the sentence was wrong whenever two causes shared a screen — "update the agent"
 * for an agent that was merely not running, "not running" for one that was too old.
 */
export type LinkReason =
  | 'not_running'
  | 'not_installed'
  | 'blocked_by_browser'
  | 'pairing_rejected'
  | 'agent_too_old'
  | 'web_too_old'
  | 'account_check_required'
  | 'account_check_unavailable'
  | 'update_in_progress'
  | 'timeout'
  | 'unknown';

export const MIN_SUPPORTED_API_VERSION = MIN_SUPPORTED_AGENT_API_VERSION;
export const MAX_SUPPORTED_API_VERSION = MAX_SUPPORTED_AGENT_API_VERSION;
export function versionState(apiVersion: number): ConnectionState {
  if (!Number.isInteger(apiVersion) || apiVersion < 0) return 'agent_update_required';
  if (apiVersion < MIN_SUPPORTED_API_VERSION) return 'agent_update_required';
  if (apiVersion > MAX_SUPPORTED_API_VERSION) return 'web_update_required';
  return 'connected';
}
export function pairingPath(agentOrigin: string, pageOrigin: string) {
  return agentOrigin === pageOrigin ? '/local' : '/pair';
}

export async function probeAgent(
  agentOrigin: string,
  pageOrigin: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(`${agentOrigin}/health`, {
      method: 'GET',
      signal,
      cache: 'no-store',
      ...agentFetchOptions(agentOrigin, pageOrigin)
    });
  } catch (error) {
    if (signal?.aborted) throw new Error('TIMEOUT', { cause: error });
    throw new Error('CONNECTION_FAILED', { cause: error });
  }

  if (!response.ok) {
    throw new Error('CONNECTION_FAILED', {
      cause: new Error(`Agent health check returned ${response.status}`)
    });
  }

  let health: unknown;
  try {
    health = await response.json();
  } catch (error) {
    throw new Error('CONNECTION_FAILED', { cause: error });
  }
  if (
    !health ||
    typeof health !== 'object' ||
    !('product' in health) ||
    health.product !== 'local-video-compressor-agent'
  ) {
    throw new Error('CONNECTION_FAILED', {
      cause: new Error('Unexpected service answered on the Agent port')
    });
  }
}

export function agentFetchOptions(agentOrigin: string, pageOrigin: string): RequestInit {
  if (agentOrigin === pageOrigin) return {};
  const hostname = new URL(agentOrigin).hostname.toLowerCase();
  // Let the browser classify literal loopback addresses itself. Chrome 145+ separates
  // "loopback" from "local"; declaring targetAddressSpace: "local" for 127.0.0.1
  // makes the request fail before it can reach the Agent or show the permission prompt.
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]') return {};
  return { targetAddressSpace: 'local' } as RequestInit;
}

/**
 * What a failed probe most likely means, when the Agent answered nothing at all.
 *
 * Three readings share one failed fetch: the Agent is not running, it was never installed,
 * or the browser refused to look at loopback. The last one has two known shapes — Chrome
 * with the local-network permission denied, which can be asked about, and Safari on the
 * hosted origin, which blocks plain-http loopback from an https page by policy (WebKit
 * 171934, 279249) and cannot be asked. For Safari the answer is the same whether or not
 * the Agent is running: the hosted page will never reach it, and the one useful action is
 * the Agent's own copy of the page. So a hosted page in Safari that has seen the Agent
 * before reads a failed probe as "blocked", not as "not running".
 */
export async function failureState(
  input: { hosted?: boolean; agentKnown?: boolean } = {}
): Promise<ConnectionState> {
  const permissions = navigator.permissions as Permissions & {
    query(descriptor: { name: string }): Promise<PermissionStatus>;
  };
  // Chrome 145 split the old permission. Keep the alias fallback for older versions.
  for (const name of ['loopback-network', 'local-network-access']) {
    try {
      const status = await permissions.query({ name });
      if (status.state === 'denied') return 'connection_blocked';
    } catch {
      /* unsupported permission name/API */
    }
  }
  if (input.hosted && input.agentKnown && currentBrowserFamily() === 'safari') {
    return 'connection_blocked';
  }
  return 'not_installed_or_not_running';
}
