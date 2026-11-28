import { CircleAlert, TriangleAlert } from 'lucide-react';
import type { SpaceStorageSummary } from '@video-compressor/shared';
import { isR2Space, spaceStorageApi } from '../../api/space-storage';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { Alert, Button } from '../../components/ui/index';
import type { TranslationKey } from '../../i18n';
import { currentRoute, navigateTo } from '../../lib/navigation';
import { buildTeamRoute, parseTeamRoute } from '../routes';
import {
  STORAGE_LEVEL_LABEL,
  lastSpaceStorage,
  readSpaceStorage,
  storageLevelOf,
  useSpaceStorage,
  useStorageWords,
  type SpaceStorageClient
} from './useSpaceStorage';

/**
 * 057 T057 (US9.4): a warning where bytes are about to be added — an upload, a catalog, its
 * variations, a re-stitch — from 80 % of the space, with what the action will take («займе
 * ≈ 1,2 ГБ») and the way to make room («Звільнити місце», the memory panel). Nothing at all in
 * a Drive space or while the space has room.
 */

/** Opens the space's memory panel where the person is (the address `storage=1`). */
export function openSpaceStorage(teamId: string): void {
  const route = parseTeamRoute(currentRoute());
  const here = route?.kind === 'space' && route.spaceId === teamId ? route : null;
  navigateTo(
    buildTeamRoute({
      spaceId: teamId,
      ...(here ? { section: here.section } : {}),
      query: { ...(here ? here.query : {}), storage: true }
    })
  );
}

/** The warning's words for an action that adds `addBytes`, or null when there is room. */
export function storageWarningCopy(
  summary: SpaceStorageSummary | null,
  addBytes: number,
  words: Pick<ReturnType<typeof useStorageWords>, 't' | 'bytes'>
): { level: 'warning' | 'critical' | 'full'; title: string; text: string } | null {
  const level = storageLevelOf(summary, addBytes);
  if (!summary || level === 'ok') return null;
  const free = summary.capacityBytes - summary.usedBytes - summary.reservedBytes;
  const values = {
    size: words.bytes(Math.max(0, Math.round(addBytes))),
    free: words.bytes(free > 0n ? free : 0n)
  };
  const key: TranslationKey =
    level === 'full'
      ? addBytes > 0
        ? 'spaceStorageWarnWontFit'
        : 'spaceStorageWarnFull'
      : addBytes > 0
        ? 'spaceStorageWarnTakes'
        : 'spaceStorageWarnFree';
  return { level, title: words.t(STORAGE_LEVEL_LABEL[level]), text: words.t(key, values) };
}

export function SpaceStorageWarning({
  teamId,
  addBytes = 0,
  client,
  onFreeUp,
  className
}: {
  teamId: string;
  /** What the action about to run would add; zero says only how full the space is. */
  addBytes?: number;
  client?: SpaceStorageClient;
  onFreeUp?: () => void;
  className?: string;
}) {
  const words = useStorageWords();
  const { summary } = useSpaceStorage(teamId, client ? { client } : {});
  const copy = storageWarningCopy(summary, addBytes, words);
  if (!copy) return null;
  const Icon = copy.level === 'warning' ? TriangleAlert : CircleAlert;
  return (
    <Alert
      className={`space-storage-warning${className ? ` ${className}` : ''}`}
      color={copy.level === 'warning' ? 'warning' : 'error'}
      variant="soft"
      icon={<Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
      title={copy.title}
      data-storage-level={copy.level}
      action={
        <Button
          size="sm"
          variant="outline"
          color="neutral"
          onClick={() => (onFreeUp ? onFreeUp() : openSpaceStorage(teamId))}
        >
          {words.t('spaceStorageFreeUp')}
        </Button>
      }
    >
      {copy.text}
    </Alert>
  );
}

/**
 * The same warning for an action that has no dialog to stand in — a drop on the explorer: what
 * the space holds now (read once if nothing is on screen yet), or null when there is room. Never
 * throws: a scale that cannot be read never holds an upload back; the server still refuses one
 * that does not fit (STORAGE_QUOTA_EXCEEDED).
 */
export async function spaceStorageNotice(
  teamId: string,
  addBytes: number,
  words: Pick<ReturnType<typeof useStorageWords>, 't' | 'bytes'>,
  client: SpaceStorageClient = spaceStorageApi
): Promise<ReturnType<typeof storageWarningCopy>> {
  if (!isR2Space(teamId)) return null;
  try {
    const summary = lastSpaceStorage(teamId) ?? (await readSpaceStorage(client, teamId, -1));
    return storageWarningCopy(summary, addBytes, words);
  } catch {
    return null;
  }
}
