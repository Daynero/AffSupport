import { useCallback, useEffect, useRef, useState } from 'react';
import type { CatalogVideoR2Availability, CatalogVideoR2Signal } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import type { CatalogVideoR2Client } from '../../api/team-catalog-video-r2';
import { useOptionalTeam } from '../TeamContext';

export interface CatalogVideoR2Row {
  enabled: boolean;
  link: CatalogVideoR2Signal['link'];
  copyState: CatalogVideoR2Signal['copyState'];
  reason: CatalogVideoR2Signal['reason'];
  pending: boolean;
  /** The last change the server refused, as an error the caller can render. */
  error: unknown;
}

export interface CatalogVideoR2Team {
  available: boolean;
  canManage: boolean;
  row(catalogId: string): CatalogVideoR2Row;
  toggle(catalogId: string, enabled: boolean): Promise<void>;
}

const OFF: CatalogVideoR2Row = {
  enabled: false,
  link: 'drive',
  copyState: null,
  reason: null,
  pending: false,
  error: null
};

/**
 * The catalog manager's view of the R2 option (050): one availability read and one
 * list of every catalog's option for the space, refreshed by the same Realtime
 * invalidations as the rest of the manager. A catalog absent from the list has
 * never had the option, which is the same as off.
 */
export function useCatalogVideoR2Team(
  teamId: string,
  client: CatalogVideoR2Client = teamApi.catalogVideoR2
): CatalogVideoR2Team {
  const team = useOptionalTeam();
  const revision = team?.revision ?? 0;
  const updaterRevision = team?.updaterRevision ?? 0;
  const [availability, setAvailability] = useState<CatalogVideoR2Availability | null>(null);
  const [signals, setSignals] = useState<ReadonlyMap<string, CatalogVideoR2Signal>>(new Map());
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, unknown>>(new Map());
  const reads = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    void client
      .availability(teamId, { signal: controller.signal })
      .then(setAvailability)
      .catch(() => {
        if (!controller.signal.aborted)
          setAvailability({
            available: false,
            reason: 'VIDEO_R2_NOT_CONFIGURED',
            canManage: false,
            contractVersion: 1
          });
      });
    return () => controller.abort();
  }, [client, teamId]);

  useEffect(() => {
    // Read even while R2 is unavailable: a catalog with the option on is deleted for
    // good by the server either way, and the delete dialogs must be able to say so.
    if (!availability) return;
    const controller = new AbortController();
    const read = ++reads.current;
    void client
      .listSignals(teamId, { signal: controller.signal })
      .then(list => {
        // An older answer never overwrites a newer one.
        if (read !== reads.current) return;
        setSignals(new Map(list.map(signal => [signal.catalogMaterialId, signal])));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [availability, client, teamId, revision, updaterRevision]);

  const toggle = useCallback(
    async (catalogId: string, enabled: boolean) => {
      setPending(current => new Map(current).set(catalogId, enabled));
      setErrors(current => {
        const next = new Map(current);
        next.delete(catalogId);
        return next;
      });
      try {
        const receipt = await client.setPreference(catalogId, { enabled });
        setSignals(current => {
          const next = new Map(current);
          const before = next.get(catalogId);
          next.set(catalogId, {
            catalogMaterialId: catalogId,
            link: before?.link ?? 'drive',
            copyState: before?.copyState ?? null,
            reason: null,
            lastSuccessfulUpdateAt: before?.lastSuccessfulUpdateAt ?? null,
            enabled: receipt.enabled,
            revision: Math.max(before?.revision ?? 0, receipt.revision)
          });
          return next;
        });
      } catch (cause) {
        setErrors(current => new Map(current).set(catalogId, cause));
      } finally {
        setPending(current => {
          const next = new Map(current);
          next.delete(catalogId);
          return next;
        });
      }
    },
    [client]
  );

  const row = useCallback(
    (catalogId: string): CatalogVideoR2Row => {
      const signal = signals.get(catalogId);
      const intended = pending.get(catalogId);
      return {
        ...OFF,
        ...(signal
          ? {
              enabled: signal.enabled,
              link: signal.link,
              copyState: signal.copyState,
              reason: signal.reason
            }
          : {}),
        ...(intended === undefined ? {} : { enabled: intended, pending: true }),
        error: errors.get(catalogId) ?? null
      };
    },
    [errors, pending, signals]
  );

  return {
    available: availability?.available === true,
    canManage: availability?.canManage === true,
    row,
    toggle
  };
}
