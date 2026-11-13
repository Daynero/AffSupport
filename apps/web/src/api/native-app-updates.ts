import {
  isNativeUpdateSnapshot,
  type NativeUpdateSnapshot,
  type NativeUpdateAction,
  type NativeUpdateCommand
} from '@video-compressor/shared';
import { request, requestBody } from './client';
export async function readNativeAppUpdate(signal?: AbortSignal): Promise<NativeUpdateSnapshot> {
  const value = await request<unknown>('/api/app-update', 'GET', signal);
  if (!isNativeUpdateSnapshot(value)) throw new Error('APP_UPDATE_INVALID');
  return value;
}
export async function commandNativeAppUpdate(
  action: NativeUpdateAction,
  body: NativeUpdateCommand,
  signal?: AbortSignal
): Promise<NativeUpdateSnapshot> {
  const value = await requestBody<unknown>(`/api/app-update/${action}`, body, 'POST', signal);
  if (!isNativeUpdateSnapshot(value)) throw new Error('APP_UPDATE_INVALID');
  return value;
}
