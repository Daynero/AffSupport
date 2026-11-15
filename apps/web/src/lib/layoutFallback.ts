import { convertKeyboardLayout, countSearchLetters } from '@video-compressor/shared';

/**
 * A server search that also tries the other keyboard layout.
 *
 * Somebody who forgot to switch layouts types "ьн" for "my" or "ghjrfgc" for
 * "прокапс". When the words as typed find nothing and they read as the other
 * layout, the same question is asked once more for those words — the rule the
 * file explorer and the local lists already follow (`filterBySearchQuery`).
 */
export async function searchWithLayoutFallback<T extends { items: readonly unknown[] }>(
  query: string,
  ask: (query: string) => Promise<T>
): Promise<T> {
  const direct = await ask(query);
  if (direct.items.length > 0 || countSearchLetters(query) < 2) return direct;
  const swapped = convertKeyboardLayout(query);
  if (!swapped) return direct;
  const retried = await ask(swapped).catch(() => null);
  return retried && retried.items.length > 0 ? retried : direct;
}
