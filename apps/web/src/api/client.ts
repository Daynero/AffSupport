import type { QueueState } from '@video-compressor/shared';

const configured = import.meta.env.VITE_AGENT_URL || 'http://127.0.0.1:43120';
export const agentUrl = location.hostname === '127.0.0.1' && location.port === '43120' ? location.origin : configured;
// Private Network Access only applies when a page in a wider address space (the hosted HTTPS
// site) reaches the loopback agent. When the UI is served by the agent itself the request is
// plain same-origin, so the exotic (and browser-version-sensitive) option must be omitted.
const privateNetworkInit: RequestInit = agentUrl === location.origin ? {} : ({ targetAddressSpace: 'local' } as RequestInit);
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('local-video-compressor-pairing');
let token = localStorage.getItem('agentToken') ?? '';
let tokenListener: (() => void) | null = null;

channel?.addEventListener('message', event => {
  if (typeof event.data === 'string' && /^[a-f0-9]{64}$/.test(event.data)) {
    token = event.data; localStorage.setItem('agentToken', token); tokenListener?.();
  }
});

export function onPairingToken(listener: () => void) { tokenListener = listener; return () => { tokenListener = null; }; }
export function consumePairingToken() {
  const value = new URLSearchParams(location.hash.slice(1)).get('agentToken');
  if (value && /^[a-f0-9]{64}$/.test(value)) {
    token = value; localStorage.setItem('agentToken', value); channel?.postMessage(value);
    history.replaceState(null, '', location.pathname + location.search);
  }
}
export function hasPairingToken() { return Boolean(token); }
export async function connect(signal?: AbortSignal): Promise<{ state: QueueState; version: string; apiVersion: number }> {
  const health = await request<{ version: string; apiVersion?: number }>('/api/health', 'GET', signal);
  const state = await request<QueueState>('/api/queue', 'GET', signal);
  return { state, version: health.version, apiVersion: health.apiVersion ?? 0 };
}
export function eventUrl() { return `${agentUrl}/api/events?token=${encodeURIComponent(token)}`; }
export async function request<T>(url: string, method = 'GET', signal?: AbortSignal): Promise<T> {
  if (!token) throw new Error('PAIRING_REQUIRED');
  let response: Response;
  try { response = await fetch(agentUrl + url, { method, signal, headers: { 'x-session-token': token }, ...privateNetworkInit }); }
  catch (error) { if (signal?.aborted) throw new Error('TIMEOUT'); throw new Error('CONNECTION_FAILED', { cause: error }); }
  return assertOk(response) as Promise<T>;
}
export async function requestBody<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(agentUrl + url, { method: 'POST', headers: { 'x-session-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body), ...privateNetworkInit });
  return assertOk(response) as Promise<T>;
}
async function assertOk(response: Response) { const body = await response.json(); if (!response.ok) throw new Error(response.status === 401 ? 'PAIRING_REQUIRED' : body.error || 'AGENT_ERROR'); return body; }
