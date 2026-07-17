import type { QueueState, SessionResponse } from '@video-compressor/shared';

let token = '';
export async function connect(): Promise<QueueState> {
  const session = await fetch('/api/session').then(assertOk) as SessionResponse;
  token = session.token;
  return request('/api/queue');
}
export function eventUrl() { return `/api/events?token=${encodeURIComponent(token)}`; }
export async function request<T>(url: string, method = 'GET'): Promise<T> {
  const response = await fetch(url, { method, headers: { 'x-session-token': token } });
  return assertOk(response) as Promise<T>;
}
export async function requestBody<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: { 'x-session-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return assertOk(response) as Promise<T>;
}
async function assertOk(response: Response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'The local agent returned an error.');
  return body;
}
