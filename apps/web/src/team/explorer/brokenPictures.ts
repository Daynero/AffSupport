/**
 * Pictures that did not load, and when (058). A tile is mounted anew each time
 * its folder is opened, and each time it asked for the picture again: an empty
 * tile, then — a quarter of a second later — the icon that stands in for it,
 * on every step back into the folder. For a while the answer is remembered and
 * the icon is there from the first frame; after that the picture gets another
 * chance, since what failed may have been the network. A tile and the file's
 * card share the memory: they ask for the same picture.
 */
const BROKEN_PICTURE_MS = 3 * 60_000;
const brokenPictures = new Map<string, number>();

export function knownBroken(key: string): boolean {
  const at = brokenPictures.get(key);
  if (at === undefined) return false;
  if (Date.now() - at < BROKEN_PICTURE_MS) return true;
  brokenPictures.delete(key);
  return false;
}

export function markBroken(key: string) {
  brokenPictures.set(key, Date.now());
}

/** Tests only. */
export function forgetBrokenPictures() {
  brokenPictures.clear();
}
