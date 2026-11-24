import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { CatalogRegistryRow } from '../../api/team';
import type { useI18n } from '../../i18n';
import type { captureCatalogMutationOwner } from './captureCatalogMutationOwner';
import type { CatalogField, useCatalogInlineChanges } from './useCatalogInlineChanges';

/**
 * Where the keyboard goes when the manager's list changes under it (out of the dialog, 070
 * T056): back to the control a recent change was undone from, and — when a saved change filters
 * its row away — to the same control on the nearest row still shown, saying so to a reader.
 */
export function useCatalogListFocus({
  owner,
  listRef,
  searchId,
  recentOpen,
  setRecentOpen,
  recentReturnTarget,
  undoCount,
  heldRows,
  inlineStates,
  setHeldRevision,
  setChangeNotice,
  t
}: {
  owner: ReturnType<typeof captureCatalogMutationOwner>;
  listRef: RefObject<HTMLTableElement | null>;
  searchId: string;
  recentOpen: boolean;
  setRecentOpen: Dispatch<SetStateAction<boolean>>;
  recentReturnTarget: { current: { catalogId?: string; field?: CatalogField } | null };
  undoCount: number;
  /** Rows kept as they were while their change is on its way, so the list does not jump. */
  heldRows: { current: Map<string, CatalogRegistryRow> };
  inlineStates: ReturnType<typeof useCatalogInlineChanges>['states'];
  setHeldRevision: Dispatch<SetStateAction<number>>;
  setChangeNotice: Dispatch<SetStateAction<string>>;
  t: ReturnType<typeof useI18n>['t'];
}) {
  useEffect(() => {
    if (!recentOpen || undoCount > 0) return;
    recentReturnTarget.current ??= {};
    setRecentOpen(false);
  }, [recentOpen, undoCount]);
  useEffect(() => {
    if (recentOpen || !recentReturnTarget.current) return;
    const target = recentReturnTarget.current;
    recentReturnTarget.current = null;
    const frame = requestAnimationFrame(() => {
      if (!owner.current()) return;
      const row = Array.from(
        listRef.current?.querySelectorAll<HTMLElement>('[data-catalog-id]') ?? []
      ).find(element => element.dataset.catalogId === target.catalogId);
      const field = target.field === 'updateInterval' ? 'schedule' : target.field;
      const control = field
        ? row?.querySelector<HTMLElement>(`[data-catalog-field="${field}"]`)
        : null;
      (control ?? document.getElementById(searchId))?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [recentOpen, searchId]);
  useEffect(() => {
    for (const [id] of heldRows.current) {
      const state = inlineStates[id];
      if (!state || state.phase === 'pending') continue;
      const active = document.activeElement as HTMLElement | null;
      const focusedRow = active?.closest<HTMLElement>('[data-catalog-id]');
      const control = active?.dataset.catalogField;
      heldRows.current.delete(id);
      setHeldRevision(value => value + 1);
      // A next render uses the acknowledged profile when applying filters and sort.
      if (state.phase === 'saved') {
        setChangeNotice(t('catalogIconsSaved'));
        const before = Array.from(
          listRef.current?.querySelectorAll<HTMLElement>('[data-catalog-id]') ?? []
        );
        const position = before.findIndex(element => element.dataset.catalogId === id);
        const neighbors = [
          ...before.slice(position + 1),
          ...before.slice(0, position).reverse()
        ].map(element => element.dataset.catalogId);
        requestAnimationFrame(() => {
          const visible = Array.from(
            listRef.current?.querySelectorAll<HTMLElement>('[data-catalog-id]') ?? []
          );
          if (!visible.some(element => element.dataset.catalogId === id)) {
            setChangeNotice(t('catalogIconsHidden'));
            if (focusedRow?.dataset.catalogId === id) {
              const neighbor = neighbors
                .map(id => visible.find(element => element.dataset.catalogId === id))
                .find(Boolean);
              const target = neighbor?.querySelector<HTMLButtonElement>(
                control ? `[data-catalog-field="${control}"]` : 'button'
              );
              (target ?? document.getElementById(searchId))?.focus();
            }
          }
        });
      }
    }
  }, [inlineStates, searchId, t]);
}
