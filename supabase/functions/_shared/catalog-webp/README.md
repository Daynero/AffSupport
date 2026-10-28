# Offline catalog WebP decoder

This directory adapts the exact published WebP codec from `playwright-core@1.62.1`
for catalog WebP-to-PNG normalization. The helper exposes only decoding. The
565,369-byte upstream WASM also contains encoder code, which this helper never
exposes or calls. No new runtime npm dependency is introduced.

## Security and provenance

Do not substitute the installed `@jsquash/webp@1.5.0` codec. Its actual
`version()` returned **65792 / libwebp 1.1.0**, despite the newer npm wrapper.
That predates the [official 1.3.2 lossless-decoder security fix](https://github.com/webmproject/libwebp/releases/tag/v1.3.2)
for CVE-2023-4863. WASM is not a reason to accept a vulnerable decoder.

The selected artifact has this verified supply chain:

1. The existing lockfile pins official `playwright-core@1.62.1` and npm integrity.
2. Its installed WASM SHA-256 exactly matches the
   [artifact published in the official v1.62.1 release source](https://github.com/microsoft/playwright/blob/v1.62.1/packages/utils/webp/webp_codec.wasm).
3. The release's [build recipe](https://github.com/microsoft/playwright/blob/v1.62.1/utils/libwebp-wasm/build.sh)
   pins official libwebp commit `3757b8afeb54e305eaef18502812a9a88b7ed662`.
   Its [configure.ac](https://github.com/webmproject/libwebp/blob/3757b8afeb54e305eaef18502812a9a88b7ed662/configure.ac)
   declares 1.6.0, and the recipe documents fixes after the 1.6.0 release.
4. The official [ancestor comparison](https://github.com/webmproject/libwebp/compare/v1.3.2...3757b8afeb54e305eaef18502812a9a88b7ed662)
   reports 542 commits ahead and zero behind; its base and merge base both equal
   `ca332209cb5567c9b249c86788cb2dbf8847e760`. The fixed 1.3.2 tag is an ancestor.

The new binary has **no version-function export**. The evidence is its exact
published bytes and documented build source, not a measured binary version.
Initialization independently hashes the embedded bytes and refuses a mismatch.
This provenance establishes inclusion of the cited fix; it is not a claim that
the codec has no other defects or that the upstream build has been independently
reproduced here. The upstream recipe uses a floating SDK selection; its binary
is pinned here as a published release artifact rather than called reproducible
from an exact compiler invocation.

| Artifact                       | Exact value                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| npm package                    | `playwright-core@1.62.1`                                                                          |
| npm tarball                    | `https://registry.npmjs.org/playwright-core/-/playwright-core-1.62.1.tgz`                         |
| Lockfile integrity             | `sha512-wPYSwEBJY9GHraISXqyqtx0na0LpO3XEX7jNDhntbex7tzUS7kLnZsOlFruFJB4Hi/rhDMjXGqHewDZ68nYZVw==` |
| Published WASM                 | `lib/webp_codec.wasm`, 565,369 bytes                                                              |
| WASM SHA-256                   | `164cd9583a3e4d081f767d3b41ff0a730443dc7535fcc5caff83561463384b79`                                |
| Factory source                 | Only `packages/utils/webp/webp_codec.js` inside `lib/coreBundle.js`                               |
| Original bundle SHA-256        | `9393fa79e1c67c74edc26b610d65a4f7ed73d345a762465cc88340a33a2454ac`                                |
| Upstream codec license SHA-256 | `995c7ee35aceb7666829b7a501ca89c0864e12b493c1174b155774ab1e03d831`                                |
| Release build recipe SHA-256   | `247f13d88347ac4fb8dd7b8ee43880503d5e35d4f1ff483c2ced282c2c281972`                                |
| Upstream configure.ac SHA-256  | `3c33c1e876e7f5837cd88c49cc6d917fb141a1b2ef95076b5ddbb39499578f61`                                |

## Runtime adaptation

`index.ts` imports generated glue and embedded WASM as ordinary source modules.
The first call lazily initializes one cached Emscripten module after checking
the WASM hash. Adaptation removes the entire Node/DOM/network loader, extracts
the factory as ESM, and limits its heap-growth callback to **128 MiB**. There is
no runtime fetch, file access, CommonJS loader or global mutation. The raw API
uses no `ImageData` constructor or canvas shim at all. Generated source follows
the same module graph as the function, including `--use-api` deployment; no
`static_files` configuration or environment-dependent WASM path is needed.

The helper explicitly frees its WASM input, dimension and result allocations in
`finally`, including rejected decodes. It copies RGBA once into a standalone
`Uint8ClampedArray` before freeing the result. The cached module retains its
bounded codec heap but no returned array; later decoding cannot overwrite a
previous result.

Callers must first validate static WebP content and the **4,000,000-pixel** bound,
then hold the catalog worker's single-isolate heavy-work permit throughout decode
and encoding. The helper checks safe positive output dimensions, the same pixel
ceiling and exact in-heap RGBA bounds before copying. Post-decode checks do not
replace allocation preflight. Animated inputs are rejected by the caller.
Actual local Edge boot, resource measurements and hosted acceptance remain
separate checks.

## Regenerate and verify

After the repository's locked npm dependencies are installed:

```sh
node scripts/generate-catalog-webp-decoder.mjs
node scripts/generate-catalog-webp-decoder.mjs --check
```

The generator refuses a changed package version, npm integrity or input hashes;
extracts only the known factory; applies the known-source changes exactly once;
and copies the complete licenses. It never downloads dependencies or builds
native code. The full package Apache-2.0 license is `LICENSE.apache-2.0.txt`.
`LICENSE.codec.txt` preserves libwebp's BSD license, Google copyright and patent
grant, plus the Emscripten MIT/NCSA licenses. Review any artifact update as a
decoder change rather than regenerating from an unreviewed dependency version.

The independent `tests/fixtures/catalog-webp/rgba-lossless.webp` fixture was
encoded from six explicit RGBA pixels by native `cwebp 1.6.0` using
`-lossless -exact -m 0`. It was not produced by this decoder or a jSquash encoder.
The regression compares every channel, including partial alpha and transparency;
initializes without a global `ImageData`; forbids fetch; and checks concurrent
initialization and independent result ownership.
