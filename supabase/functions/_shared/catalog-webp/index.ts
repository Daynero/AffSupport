import createDecoder from './decoder.js';
import { CATALOG_WEBP_WASM_BASE64, CATALOG_WEBP_WASM_SHA256 } from './wasm.ts';

export interface CatalogWebpPixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

interface Decoder {
  _malloc(size: number): number;
  _free(pointer: number): void;
  _webp_free(pointer: number): void;
  _webp_decode_rgba(input: number, length: number, width: number, height: number): number;
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
}

type DecoderFactory = (options: { wasmBinary: Uint8Array }) => Promise<Decoder>;
let decoderPromise: Promise<Decoder> | undefined;

function decoder(): Promise<Decoder> {
  if (!decoderPromise) {
    decoderPromise = (async () => {
      const binary = atob(CATALOG_WEBP_WASM_BASE64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1)
        bytes[index] = binary.charCodeAt(index);
      // This artifact has no version() export. Pin the actual reviewed published bytes.
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const hash = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
      if (hash !== CATALOG_WEBP_WASM_SHA256) throw new Error('CATALOG_WEBP_CODEC_INTEGRITY');
      return (createDecoder as unknown as DecoderFactory)({ wasmBinary: bytes });
    })();
  }
  return decoderPromise;
}

/** Caller validates static WebP content and the 4 MP bound before acquiring its decode permit. */
export async function decodeCatalogWebp(bytes: Uint8Array): Promise<CatalogWebpPixels> {
  const codec = await decoder();
  let input = 0;
  let dimensions = 0;
  let output = 0;
  try {
    input = codec._malloc(bytes.length);
    dimensions = codec._malloc(8);
    if (!input || !dimensions) throw new Error('CATALOG_WEBP_DECODE_FAILED');
    codec.HEAPU8.set(bytes, input);
    codec.HEAPU32[dimensions >>> 2] = 0;
    codec.HEAPU32[(dimensions + 4) >>> 2] = 0;
    output = codec._webp_decode_rgba(input, bytes.length, dimensions, dimensions + 4);
    const width = codec.HEAPU32[dimensions >>> 2]!;
    const height = codec.HEAPU32[(dimensions + 4) >>> 2]!;
    const length = width * height * 4;
    if (
      !output ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > 4_000_000 ||
      output + length > codec.HEAPU8.length
    )
      throw new Error('CATALOG_WEBP_DECODE_FAILED');
    const data = new Uint8ClampedArray(length);
    data.set(codec.HEAPU8.subarray(output, output + length));
    return { data, width, height };
  } finally {
    if (output) codec._webp_free(output);
    if (dimensions) codec._free(dimensions);
    if (input) codec._free(input);
  }
}
