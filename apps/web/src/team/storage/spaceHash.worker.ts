import { hashSpaceParts, type SpaceHashMessage, type SpaceHashRequest } from './spaceHash';

/**
 * 057 T045: the MD5 of every part of one file, off the page's thread. The file is read in 4 MiB
 * slices straight from the `File` the page handed over (a reference, not a copy), so the page
 * stays responsive while the hashes that name the content are made.
 */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SpaceHashRequest>) => void) | null;
  postMessage(message: SpaceHashMessage): void;
};

scope.onmessage = event => {
  const { id, source } = event.data;
  hashSpaceParts(source, {
    onProgress: hashed => scope.postMessage({ id, type: 'progress', hashed })
  }).then(
    md5s => scope.postMessage({ id, type: 'done', md5s }),
    () => scope.postMessage({ id, type: 'error' })
  );
};
