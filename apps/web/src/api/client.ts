import type { QueueState } from '@video-compressor/shared';
const configured = import.meta.env.VITE_AGENT_URL || 'http://127.0.0.1:43120';
export const agentUrl = location.hostname === '127.0.0.1' && location.port === '43120' ? location.origin : configured;
let token = sessionStorage.getItem('agentToken') ?? '';
export function consumePairingToken() { const params = new URLSearchParams(location.hash.slice(1)); const value = params.get('agentToken'); if (value && /^[a-f0-9]{64}$/.test(value)) { token=value; sessionStorage.setItem('agentToken',value); history.replaceState(null,'',location.pathname+location.search); } }
export async function connect(signal?:AbortSignal):Promise<QueueState>{return request('/api/queue','GET',signal)}
export function eventUrl(){return `${agentUrl}/api/events?token=${encodeURIComponent(token)}`}
export async function request<T>(url:string,method='GET',signal?:AbortSignal):Promise<T>{if(!token)throw new Error('PAIRING_REQUIRED');const response=await fetch(agentUrl+url,{method,signal,headers:{'x-session-token':token},targetAddressSpace:'local'} as RequestInit);return assertOk(response) as Promise<T>}
export async function requestBody<T>(url:string,body:unknown):Promise<T>{const response=await fetch(agentUrl+url,{method:'POST',headers:{'x-session-token':token,'content-type':'application/json'},body:JSON.stringify(body),targetAddressSpace:'local'} as RequestInit);return assertOk(response) as Promise<T>}
async function assertOk(response:Response){const body=await response.json();if(!response.ok)throw new Error(response.status===401?'PAIRING_REQUIRED':body.error||'The local agent returned an error.');return body}
