import type {
  HealthResponse,
  ImageSlot,
  LandingState,
  QueueState,
  SelectionResponse,
  ToolContracts
} from '@video-compressor/shared';
import { agentFetchOptions, pairingPath, probeAgent, versionState } from '../connection';

const configured = import.meta.env.VITE_AGENT_URL || 'http://127.0.0.1:43120';
export const agentUrl =
  location.hostname === '127.0.0.1' && location.port === '43120' ? location.origin : configured;
const privateNetworkInit = agentFetchOptions(agentUrl, location.origin);
const channel =
  typeof BroadcastChannel === 'undefined'
    ? null
    : new BroadcastChannel('local-video-compressor-pairing');
let token = localStorage.getItem('agentToken') ?? '';
let tokenListener: (() => void) | null = null;
const INSTALL_STARTED_KEY = 'wishly.agent-install-started.v1';
const INSTALL_PAIRING_WINDOW_MS = 15 * 60 * 1000;

channel?.addEventListener('message', event => {
  if (typeof event.data === 'string' && /^[a-f0-9]{64}$/.test(event.data)) {
    token = event.data;
    localStorage.setItem('agentToken', token);
    tokenListener?.();
  }
});

export function onPairingToken(listener: () => void) {
  tokenListener = listener;
  return () => {
    tokenListener = null;
  };
}
export function consumePairingToken() {
  const value = new URLSearchParams(location.hash.slice(1)).get('agentToken');
  if (value && /^[a-f0-9]{64}$/.test(value)) {
    token = value;
    localStorage.setItem('agentToken', value);
    sessionStorage.removeItem(INSTALL_STARTED_KEY);
    channel?.postMessage(value);
    history.replaceState(null, '', location.pathname + location.search);
  }
}
export function markAgentInstallStarted() {
  sessionStorage.setItem(INSTALL_STARTED_KEY, String(Date.now()));
}
export function agentInstallAwaitingPairing() {
  const started = Number(sessionStorage.getItem(INSTALL_STARTED_KEY));
  if (!Number.isFinite(started) || Date.now() - started > INSTALL_PAIRING_WINDOW_MS) {
    sessionStorage.removeItem(INSTALL_STARTED_KEY);
    return false;
  }
  return true;
}
export function hasPairingToken() {
  return Boolean(token);
}
export function pairWithAgent() {
  location.assign(`${agentUrl}${pairingPath(agentUrl, location.origin)}`);
}
export async function connect(signal?: AbortSignal): Promise<{
  state: QueueState | null;
  version: string;
  buildId: string;
  channel: string;
  apiVersion: number;
  capabilities: string[];
  toolContracts: ToolContracts;
}> {
  if (!token) {
    await probeAgent(agentUrl, location.origin, signal);
    throw new Error('PAIRING_REQUIRED');
  }
  const health = await request<Partial<HealthResponse> & { version: string }>(
    '/api/health',
    'GET',
    signal
  );
  const apiVersion = health.apiVersion ?? 0;
  const capabilities = Array.isArray(health.capabilities) ? health.capabilities : [];
  const { normalizeToolContracts } = await import('@video-compressor/shared');
  const toolContracts = normalizeToolContracts(health.toolContracts, capabilities, apiVersion);
  const state =
    versionState(apiVersion) === 'connected'
      ? await request<QueueState>('/api/queue', 'GET', signal)
      : null;
  return {
    state,
    version: health.version,
    buildId: health.buildId ?? '',
    channel: health.channel ?? 'unknown',
    apiVersion,
    capabilities,
    toolContracts
  };
}
export function eventUrl() {
  return `${agentUrl}/api/events?token=${encodeURIComponent(token)}`;
}
export async function request<T>(url: string, method = 'GET', signal?: AbortSignal): Promise<T> {
  if (!token) throw new Error('PAIRING_REQUIRED');
  let response: Response;
  try {
    response = await fetch(agentUrl + url, {
      method,
      signal,
      cache: 'no-store',
      headers: { 'x-session-token': token },
      ...privateNetworkInit
    });
  } catch (error) {
    if (signal?.aborted) throw new Error('TIMEOUT', { cause: error });
    throw new Error('CONNECTION_FAILED', { cause: error });
  }
  return assertOk(response) as Promise<T>;
}
export async function requestBody<T>(url: string, body: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(agentUrl + url, {
    method,
    headers: { 'x-session-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...privateNetworkInit
  });
  return assertOk(response) as Promise<T>;
}
export async function uploadFile(file: File): Promise<SelectionResponse> {
  const body = new FormData();
  body.append('signature', `${file.name}:${file.size}:${file.lastModified}`);
  body.append('file', file, file.name);
  let response: Response;
  try {
    response = await fetch(agentUrl + '/api/files/upload', {
      method: 'POST',
      headers: { 'x-session-token': token },
      body,
      ...privateNetworkInit
    });
  } catch (error) {
    throw new Error('CONNECTION_FAILED', { cause: error });
  }
  return assertOk(response) as Promise<SelectionResponse>;
}
export async function uploadImage(slot: ImageSlot, file: File): Promise<QueueState> {
  const body = new FormData();
  body.append('file', file, file.name);
  let response: Response;
  try {
    response = await fetch(`${agentUrl}/api/images/${slot}`, {
      method: 'POST',
      headers: { 'x-session-token': token },
      body,
      ...privateNetworkInit
    });
  } catch (error) {
    throw new Error('CONNECTION_FAILED', { cause: error });
  }
  return assertOk(response) as Promise<QueueState>;
}
export function imageContentUrl(id: string) {
  return `${agentUrl}/api/images/${encodeURIComponent(id)}/content?token=${encodeURIComponent(token)}`;
}
export function landingEventUrl() {
  return `${agentUrl}/api/landing/events?token=${encodeURIComponent(token)}`;
}
async function uploadForm<T>(url: string, body: FormData): Promise<T> {
  let response: Response;
  try {
    response = await fetch(agentUrl + url, {
      method: 'POST',
      headers: { 'x-session-token': token },
      body,
      ...privateNetworkInit
    });
  } catch (error) {
    throw new Error('CONNECTION_FAILED', { cause: error });
  }
  return assertOk(response) as Promise<T>;
}
export async function uploadLandingZip(file: File): Promise<LandingState> {
  const body = new FormData();
  body.append('file', file, file.name);
  return uploadForm<LandingState>('/api/landing/upload/zip', body);
}
export async function landingFolderBegin(name: string): Promise<LandingState> {
  return requestBody<LandingState>('/api/landing/upload/folder/begin', { name });
}
export async function landingFolderFile(relPath: string, file: File): Promise<{ ok: boolean }> {
  const body = new FormData();
  body.append('relPath', relPath);
  body.append('file', file, file.name);
  return uploadForm<{ ok: boolean }>('/api/landing/upload/folder/file', body);
}
export async function landingFolderFinish(): Promise<LandingState> {
  return request<LandingState>('/api/landing/upload/folder/finish', 'POST');
}
async function assertOk(response: Response) {
  const body = await response.json();
  if (!response.ok)
    throw new Error(response.status === 401 ? 'PAIRING_REQUIRED' : body.error || 'AGENT_ERROR');
  return body;
}
