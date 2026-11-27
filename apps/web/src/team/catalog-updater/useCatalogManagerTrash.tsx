import { useEffect, useRef, useState } from 'react';
import type { TeamPermissions } from '@video-compressor/shared';
import type { CatalogRegistryRow } from '../../api/team';
import { TeamApiError, teamApi } from '../../api/team';
import type { useToasts } from '../../components/toast';
import type { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { BulkTrashPanel } from '../explorer/BulkTrashPanel';
import { useOptionalWorkspaceOperations } from '../explorer/WorkspaceOperationsProvider';
import type { captureCatalogMutationOwner } from './captureCatalogMutationOwner';

type Owner = ReturnType<typeof captureCatalogMutationOwner>;

/**
 * Deleting catalogs from the manager (out of its dialog, 070 T056): through the space's bulk
 * trash when there is one — the manager reports those receipts itself, with catalog names — and
 * one by one otherwise.
 */
export function useCatalogManagerTrash({
  teamId,
  rows,
  permissions,
  owner,
  withBusy,
  setSelected,
  confirmDelete,
  setConfirmDelete,
  reload,
  onChanged,
  push,
  t
}: {
  teamId: string;
  rows: readonly CatalogRegistryRow[];
  permissions: TeamPermissions | null | undefined;
  owner: Owner;
  withBusy: (ids: string[], work: () => Promise<void>) => Promise<void>;
  setSelected: (update: (current: Set<string>) => Set<string>) => void;
  confirmDelete: string[];
  setConfirmDelete: (ids: string[]) => void;
  reload: () => void;
  onChanged?: () => void;
  push: ReturnType<typeof useToasts>['push'];
  t: ReturnType<typeof useI18n>['t'];
}) {
  const workspaceOperations = useOptionalWorkspaceOperations();
  const [trashGroups, setTrashGroups] = useState<Set<string>>(() => new Set());
  const directTrashKeys = useRef(new Map<string, string>());
  const observedTrash = useRef('');
  const registry = { reload };

  const trashRows = rows.map(row => ({
    id: row.catalogId,
    name: row.name,
    category: 'other' as const
  }));
  const managerTrash = workspaceOperations?.bulkTrash;
  const currentCatalogIds = new Set(trashRows.map(row => row.id));
  const receipts =
    managerTrash?.groups.filter(
      group =>
        group.teamId === teamId &&
        (trashGroups.has(group.id) ||
          group.items.some(item => currentCatalogIds.has(item.materialId)))
    ) ?? [];
  // The manager reports these itself, with catalog names; the Files corner leaves them.
  const claimKey = receipts.map(group => group.id).join(',');
  const claimTrash = managerTrash?.claim;
  useEffect(() => {
    if (!claimKey || !claimTrash) return;
    return claimTrash(claimKey.split(','));
  }, [claimKey, claimTrash]);
  const receiptFingerprint = receipts
    .map(
      group =>
        `${group.id}:${group.items
          .map(item => {
            const history =
              managerTrash?.historicalReceipts?.get(group.id)?.get(item.materialId) ??
              item.historicalReceipt;
            return `${item.materialId}:${item.state}:${history ? `${history.state}:${history.memberCount}:${history.matchingCount}:${history.missingCount}` : 'current'}`;
          })
          .join(',')}`
    )
    .join('|');
  useEffect(() => {
    if (!receiptFingerprint || observedTrash.current === receiptFingerprint) return;
    observedTrash.current = receiptFingerprint;
    const confirmed = new Set(
      receipts.flatMap(group =>
        group.items
          .filter(
            item =>
              item.state === 'confirmed' &&
              !managerTrash?.historicalReceipts?.get(group.id)?.has(item.materialId)
          )
          .map(item => item.materialId)
      )
    );
    if (confirmed.size)
      setSelected(current => new Set([...current].filter(id => !confirmed.has(id))));
    registry.reload();
    onChanged?.();
  }, [receiptFingerprint, registry.reload, onChanged]);
  const deleteSelected = async () => {
    const detached = new Set(
      rows
        .filter(
          row => confirmDelete.includes(row.catalogId) && row.driveConnection?.state === 'detached'
        )
        .map(row => row.catalogId)
    );
    const ids = confirmDelete.filter(id => !detached.has(id));
    // A catalog in the previous Drive folder cannot be trashed on Drive (Soty has no access to
    // that folder any more): it is taken out of Soty instead (production 2026-11-27).
    if (detached.size) {
      await withBusy([...detached], async () => {
        try {
          for (const catalogId of detached) {
            if (!owner.current()) return;
            await teamApi.forgetDetachedCatalog(teamId, catalogId);
            setSelected(current => new Set([...current].filter(id => id !== catalogId)));
          }
          if (!ids.length) setConfirmDelete([]);
        } catch (error) {
          if (owner.current()) push({ tone: 'error', text: teamErrorMessageFor(error, t) });
        } finally {
          if (owner.current()) {
            registry.reload();
            onChanged?.();
          }
        }
      });
      if (!ids.length || !owner.current()) return;
    }
    await withBusy(ids, async () => {
      if (managerTrash) {
        const group = await managerTrash.start(
          trashRows.filter(row => ids.includes(row.id)),
          teamApi
        );
        if (!owner.current()) return;
        setTrashGroups(current => new Set([...current, group.id]));
        setConfirmDelete([]);
        return;
      }
      try {
        for (const materialId of ids) {
          if (!owner.current()) return;
          const idempotencyKey = directTrashKeys.current.get(materialId) ?? crypto.randomUUID();
          directTrashKeys.current.set(materialId, idempotencyKey);
          const result = await teamApi.trashMaterial({ teamId, materialId, idempotencyKey });
          if (!owner.current()) return;
          if (result.state !== 'succeeded')
            throw new TeamApiError('PROCESS_RESULT_UNCERTAIN', true);
          if (result.materialId !== null && result.materialId !== materialId)
            throw new TeamApiError('INVALID_RESPONSE', false);
          directTrashKeys.current.delete(materialId);
          setSelected(current => new Set([...current].filter(id => id !== materialId)));
        }
        setConfirmDelete([]);
      } finally {
        if (owner.current()) {
          registry.reload();
          onChanged?.();
        }
      }
    });
  };

  const trashPanels = managerTrash
    ? receipts.map(group => (
        <BulkTrashPanel
          key={group.id}
          group={group}
          historicalReceipts={managerTrash.historicalReceipts?.get(group.id)}
          rows={trashRows}
          names={managerTrash.names}
          executing={managerTrash.executing?.has(group.id)}
          uncertain={managerTrash.uncertain}
          onVisible={managerTrash.acknowledgeVisible}
          onDismiss={managerTrash.dismiss}
          onRetry={
            permissions?.delete && managerTrash.owns(group)
              ? () => {
                  void managerTrash
                    .retry(group, trashRows, teamApi)
                    .then(() => registry.reload())
                    .catch(error => push({ tone: 'error', text: teamErrorMessageFor(error, t) }));
                }
              : undefined
          }
        />
      ))
    : null;

  return { managerTrash, receipts, trashPanels, deleteSelected };
}
