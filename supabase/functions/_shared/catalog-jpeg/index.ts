import decode, { beginJpegAllocationScope } from './decoder.js';

interface DecodedJpeg {
  width: number;
  height: number;
  data: Uint8Array;
}
type StrictDecoder = (
  bytes: Uint8Array,
  options: {
    useTArray: true;
    formatAsRGBA: false;
    tolerantDecoding: false;
    maxResolutionInMP: 4;
    maxMemoryUsageInMB: 64;
  }
) => DecodedJpeg;

/** Validate decodability only; no decoded pixels escape and encoded bytes are never changed. */
export function assertCatalogJpegDecodes(
  bytes: Uint8Array,
  expectedWidth: number,
  expectedHeight: number
): void {
  if (
    !Number.isSafeInteger(expectedWidth) ||
    !Number.isSafeInteger(expectedHeight) ||
    expectedWidth < 1 ||
    expectedHeight < 1 ||
    expectedWidth * expectedHeight > 4_000_000 ||
    bytes.length > 8_000_000
  )
    throw new Error('JPEG_RESOURCE_LIMIT');
  const releaseAllocations = beginJpegAllocationScope(bytes.buffer);
  try {
    const image = (decode as unknown as StrictDecoder)(bytes, {
      useTArray: true,
      formatAsRGBA: false,
      tolerantDecoding: false,
      maxResolutionInMP: 4,
      maxMemoryUsageInMB: 64
    });
    if (
      image.width !== expectedWidth ||
      image.height !== expectedHeight ||
      !(image.data instanceof Uint8Array) ||
      image.data.length !== expectedWidth * expectedHeight * 3
    )
      throw new Error('JPEG_DECODE_FAILED');
  } catch (error) {
    if (
      error instanceof Error &&
      /maxResolutionInMP|maxMemoryUsageInMB|Could not allocate enough memory|JPEG scan (?:count|work) limit/u.test(
        error.message
      )
    )
      throw new Error('JPEG_RESOURCE_LIMIT', { cause: error });
    throw new Error('JPEG_DECODE_FAILED', { cause: error });
  } finally {
    releaseAllocations();
  }
}
