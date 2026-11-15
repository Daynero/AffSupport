import { useCardMarqueeSelection } from '../useCardMarqueeSelection';

/** Drag from the gaps in the launch grid to select every card the rectangle touches. */
export function useLaunchMarqueeSelection(
  rows: readonly { id: string }[],
  selectedIds: ReadonlySet<string>,
  setSelectedIds: (ids: ReadonlySet<string>) => void
) {
  return useCardMarqueeSelection(rows, selectedIds, setSelectedIds, 'data-launch-id');
}
