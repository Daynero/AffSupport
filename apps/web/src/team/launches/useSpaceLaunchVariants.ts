import { useState } from 'react';
import type { LaunchGeneration } from '@video-compressor/shared';
import { useCatalogFeedSpace } from '../product-catalog/CatalogFeedAddress';
import {
  SPACE_VARIANTS_UNREACHABLE,
  useSpaceCatalogVariantRunner,
  type SpaceVariantSetWork
} from '../product-catalog/spaceCatalogVariants';

/**
 * 057 T119: the re-stitched variations of an R2 space's Launch run on the member's open Soty in
 * the foreground, the way a Drive Launch's do: while the Launch is open, its page hands each
 * set's variations to this computer's agent (space-storage `/catalog-variants/run`, workspace
 * contract 3), exactly as the catalog dialog does. Background work, when the member has it,
 * continues them with the page closed; the server keeps each variation to one machine.
 */

const DONE_STATES = ['succeeded', 'canceled', 'cancel_requested', 'canceled_with_cleanup_pending'];

/** The sets of a generation still to make, or none when it is not an R2 one in progress. */
export function spaceLaunchVariantSets(
  generation: LaunchGeneration | null | undefined
): SpaceVariantSetWork[] {
  const video = generation?.videoGeneration;
  if (
    !generation ||
    DONE_STATES.includes(generation.state) ||
    !video?.spaceSets ||
    !['accepted', 'preparing'].includes(video.state)
  )
    return [];
  return video.spaceSets
    .filter(set => set.registeredCount < set.requestedCount)
    .map(set => ({ setId: set.setId, count: set.requestedCount }));
}

/**
 * Codes a pass stops on without anything to show: Soty not reachable here (the progress says when
 * nothing else makes them), or sets this person may not hand over (another member's Launch).
 */
const QUIET = new Set([SPACE_VARIANTS_UNREACHABLE, 'NOT_FOUND', 'PERMISSION_DENIED']);

export function useSpaceLaunchVariants(input: {
  teamId: string;
  generation: LaunchGeneration | null | undefined;
  onMade(): void;
  onStopped(code: string): void;
}): void {
  const space = useCatalogFeedSpace(input.teamId);
  // Another member's sets are never theirs to hand over: stop asking for this generation.
  const [refused, setRefused] = useState<string | null>(null);
  const sets = space ? spaceLaunchVariantSets(input.generation) : [];
  useSpaceCatalogVariantRunner({
    active: sets.length > 0 && refused !== input.generation?.id,
    teamId: input.teamId,
    sets,
    onMade: () => input.onMade(),
    onStopped: code => {
      if (code === 'NOT_FOUND' || code === 'PERMISSION_DENIED')
        setRefused(input.generation?.id ?? null);
      if (!QUIET.has(code)) input.onStopped(code);
    }
  });
}
