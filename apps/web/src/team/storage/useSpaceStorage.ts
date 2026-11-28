import { useEffect, useState } from 'react';
import {
  SPACE_STORAGE_CATEGORIES,
  spaceStorageLevel,
  type SpaceStorageCategory,
  type SpaceStorageLevel,
  type SpaceStorageSummary
} from '@video-compressor/shared';
import { isR2Space, spaceStorageApi } from '../../api/space-storage';
import { formatSize } from '../../format';
import { useI18n, type TranslationKey } from '../../i18n';
import { registerPrivateCache } from '../private-cache-scope';
import { useSpaceUsageRevision } from './spaceSignals';

/**
 * 057 T057: the storage of an R2 space as every screen reads it — one summary per space, read
 * once however many places show it, and read again on each `usage` signal (FR-045: the ledger
 * changes in the transaction of the commit or delete, and says so on the space's channel), so
 * every open window follows a change within a second or two (SC-013). A Drive space has none.
 */

export interface SpaceStorageClient {
  storageSummary(teamId: string): Promise<SpaceStorageSummary>;
}

interface Entry {
  revision: number;
  promise: Promise<SpaceStorageSummary>;
  value: SpaceStorageSummary | null;
}

const entries = new Map<string, Entry>();
registerPrivateCache(() => entries.clear());

/** The summary as of `revision`: one request per space and revision, shared by every reader. */
export function readSpaceStorage(
  client: SpaceStorageClient,
  teamId: string,
  revision: number
): Promise<SpaceStorageSummary> {
  const kept = entries.get(teamId);
  if (kept && kept.revision === revision) return kept.promise;
  const entry: Entry = {
    revision,
    value: kept?.value ?? null,
    promise: client.storageSummary(teamId)
  };
  entries.set(teamId, entry);
  entry.promise.then(
    value => {
      if (entries.get(teamId) === entry) entry.value = value;
    },
    () => {
      if (entries.get(teamId) === entry) entries.delete(teamId);
    }
  );
  return entry.promise;
}

/** What was last read for the space, to draw at once while the next read is under way. */
export function lastSpaceStorage(teamId: string): SpaceStorageSummary | null {
  return entries.get(teamId)?.value ?? null;
}

export function clearSpaceStorageReads(): void {
  entries.clear();
}

export function useSpaceStorage(
  teamId: string,
  options: { enabled?: boolean; client?: SpaceStorageClient } = {}
): { summary: SpaceStorageSummary | null; failed: boolean; reload: () => void } {
  const client = options.client ?? spaceStorageApi;
  const enabled = (options.enabled ?? true) && isR2Space(teamId);
  const signals = useSpaceUsageRevision(teamId, enabled);
  const [manual, setManual] = useState(0);
  const [state, setState] = useState<{ summary: SpaceStorageSummary | null; failed: boolean }>(
    () => ({ summary: enabled ? lastSpaceStorage(teamId) : null, failed: false })
  );

  useEffect(() => {
    if (!enabled) {
      setState({ summary: null, failed: false });
      return;
    }
    let active = true;
    void readSpaceStorage(client, teamId, signals * 1_000 + manual).then(
      summary => {
        if (active) setState({ summary, failed: false });
      },
      () => {
        // The last good scale stays on screen; the next signal tries again.
        if (active) setState(current => ({ summary: current.summary, failed: true }));
      }
    );
    return () => {
      active = false;
    };
  }, [client, enabled, manual, signals, teamId]);

  return { ...state, reload: () => setManual(value => value + 1) };
}

/** How full the space is, counting what an action about to run would add (US9.4). */
export function storageLevelOf(
  summary: SpaceStorageSummary | null,
  addBytes = 0
): SpaceStorageLevel {
  if (!summary) return 'ok';
  return spaceStorageLevel({
    usedBytes: summary.usedBytes,
    reservedBytes: summary.reservedBytes,
    capacityBytes: summary.capacityBytes,
    addBytes: BigInt(Math.max(0, Math.round(addBytes)))
  });
}

export const STORAGE_CATEGORY_LABEL: Readonly<Record<SpaceStorageCategory, TranslationKey>> = {
  materials: 'spaceStorageCategoryMaterials',
  catalogs: 'spaceStorageCategoryCatalogs',
  process: 'spaceStorageCategoryProcess',
  attachments: 'spaceStorageCategoryAttachments',
  versions: 'spaceStorageCategoryVersions',
  trash: 'spaceStorageCategoryTrash'
};

export const STORAGE_LEVEL_LABEL: Readonly<
  Record<Exclude<SpaceStorageLevel, 'ok'>, TranslationKey>
> = {
  warning: 'spaceStorageLevelWarning',
  critical: 'spaceStorageLevelCritical',
  full: 'spaceStorageLevelFull'
};

/** The words every storage surface shares: sizes, shares, the summary line. */
export function useStorageWords() {
  const { t, language } = useI18n();
  const bytes = (value: bigint | number) => formatSize(Number(value), language);
  const share = (value: number) =>
    new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(value);
  const summaryLine = (summary: SpaceStorageSummary) =>
    t('spaceStorageUsedOf', {
      used: bytes(summary.usedBytes),
      capacity: bytes(summary.capacityBytes)
    });
  return { t, language, bytes, share, summaryLine, categories: SPACE_STORAGE_CATEGORIES };
}
