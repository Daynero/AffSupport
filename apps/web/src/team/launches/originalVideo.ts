import {
  parseLaunchConfig,
  launchValuesEqual,
  type LaunchConfig,
  type LaunchDetail,
  type LaunchDraft,
  type LaunchSourceSnapshot
} from '@video-compressor/shared';
import { launchReply } from './reply';
import { TeamApiError } from '../../api/team';

/** Retire the previous attempt before a different video policy can be accepted. */
export async function prepareOriginalVideo(input: {
  detail: LaunchDetail;
  cancel: (detail: LaunchDetail) => Promise<void>;
  read: () => Promise<LaunchDetail>;
  selection: (config: LaunchDraft) => Promise<LaunchSourceSnapshot>;
  signal?: AbortSignal;
  onWaiting?: (detail: LaunchDetail) => void;
}) {
  const original = input.detail;
  if (
    !original.generation ||
    original.draft.method !== 'catalog' ||
    !original.draft.catalog?.restitchEnabled
  )
    throw new TeamApiError('WRONG_STATE', false);
  if (input.signal?.aborted) throw new TeamApiError('PROCESS_CANCELED', false);
  await input.cancel(original);
  let latest = await launchReply(input.read());
  const deadline = Date.now() + 60_000;
  while (
    latest.id === original.id &&
    latest.generation?.id === original.generation.id &&
    ['cancel_requested', 'canceled_with_cleanup_pending'].includes(latest.generation.state)
  ) {
    input.onWaiting?.(latest);
    if (input.signal?.aborted) throw new TeamApiError('PROCESS_CANCELED', false);
    if (Date.now() >= deadline) throw new TeamApiError('LAUNCH_BUSY', true);
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        reject(new TeamApiError('PROCESS_CANCELED', false));
      };
      const timer = setTimeout(() => {
        input.signal?.removeEventListener('abort', stop);
        resolve();
      }, 2000);
      input.signal?.addEventListener('abort', stop, { once: true });
    });
    if (input.signal?.aborted) throw new TeamApiError('PROCESS_CANCELED', false);
    latest = await launchReply(input.read());
  }
  if (input.signal?.aborted) throw new TeamApiError('PROCESS_CANCELED', false);
  if (latest.id !== original.id || latest.generation?.id !== original.generation.id)
    throw new TeamApiError('LAUNCH_VERSION_CONFLICT', false);
  if (latest.generation.state !== 'canceled') throw new TeamApiError('LAUNCH_BUSY', true);
  if (!launchValuesEqual(latest.draft, original.draft))
    throw new TeamApiError('LAUNCH_VERSION_CONFLICT', false);
  const parsed = parseLaunchConfig(latest.draft);
  if (!parsed.ok || parsed.value.method !== 'catalog')
    throw new TeamApiError('INVALID_INPUT', false);
  const config: LaunchConfig = {
    ...parsed.value,
    catalog: { ...parsed.value.catalog, restitchEnabled: false }
  };
  const sources = await input.selection(config);
  return { detail: latest, config, sources };
}
