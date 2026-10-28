# Bounded JPEG validation

This vendors only `lib/decoder.js` from the official `jpeg-js@0.4.4` npm artifact.
It validates that supported baseline/progressive, 8-bit, one/three-component JPEG
data can be decoded within a bounded allocation budget. Decoded pixels never
escape `assertCatalogJpegDecodes`; source bytes are read without cloning or mutation.
This helper never encodes JPEG or changes quantized coefficients, scans, ICC or EXIF.

Every newly allocated decoder typed-array backing store belongs to an explicit
synchronous validation scope. Coefficients and component rows use one slab per
component with nonoverlapping views. After validating the raster, or after any
failure, `finally` detaches those owned stores with `ArrayBuffer.transfer(0)` and
clears ownership references. The encoded input buffer and module constants are
explicitly excluded. A runtime without this detachment operation is refused
before decoding with `JPEG_RESOURCE_LIMIT`; there is no fallback to waiting for
garbage collection. This establishes released backing-store ownership, not an
unmeasured guarantee about the operating system allocator's retained RSS.

The wrapper passes `useTArray:true`, `formatAsRGBA:false`,
`tolerantDecoding:false`, `maxResolutionInMP:4` and `maxMemoryUsageInMB:64`.
It requires the expected dimensions and exactly three output bytes per pixel,
including grayscale expansion. It returns no image and retains no result reference.
Callers first apply the source/container and format policy, then hold the existing
single-isolate heavy-work permit. The canonical JPEG input is limited to 8 MB;
the 4 MP dimension ceiling is independent of PNG's limit.

Synchronous entropy work has two additional fixed admission limits: at most
**32 SOS scans**, and at most **64,000,000 pixel-scan units** (the sum of full
frame pixels for each scan). Each scan is checked before entropy decoding. A
4 MP image can therefore use at most 16 scans; smaller images remain subject
to the 32-scan cap. Valid but more elaborate scan schedules are explicitly
refused as `JPEG_RESOURCE_LIMIT`; the validator does not extend its deadline.
For every progressive component and all 64 coefficient positions, first scans
must be unique and refinements must start at that coefficient's current bit
position and decrease it by one. Duplicate AC first passes and skipped or
reversed refinement levels are rejected before entropy work.

The decoder's counter accounts for coefficient typed arrays (256 bytes per block),
component scanline storage, intermediate color data and final RGB output. It is a
**cumulative typed-allocation counter**, not a hard 64 MiB process heap limit:
JavaScript array/object overhead, constant tables and caller-owned input are
additional. Some valid 4 MP images with expensive sampling can exceed the budget
and are explicitly refused as `JPEG_RESOURCE_LIMIT`. Actual Edge CPU/RSS acceptance
is measured separately. No silent return or image fallback occurs on refusal.

Upstream's tolerant flag alone does not disable every repair path. The reproducible
adaptation removes CJS/window/XMLHttpRequest and Buffer paths; uses the input's
read-only byte view; avoids comment string copies; bounds marker/entropy reads;
checks supported frame/SOS structure, coefficient progression and scan work; requires decoded DC,
quantization and Huffman evidence; rejects marker repair and extra trailing scan
data. It still relies on jpeg-js's entropy and progressive reconstruction logic.
This is stronger decodability evidence than a container-only parser, **not a claim
of complete JPEG/T.81 conformance or proof that every possible malformed entropy
sequence is rejected**. Its decoded colors are not used for publication or raster
conversion. Original encoded bytes remain the rendering authority.

Errors are plain `JPEG_DECODE_FAILED` or `JPEG_RESOURCE_LIMIT`; the product layer
maps them to its existing structured errors. No file names or source data appear
in these messages.

## Provenance and regeneration

| Input                    | Pinned value                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| Official tarball         | `https://registry.npmjs.org/jpeg-js/-/jpeg-js-0.4.4.tgz`                                          |
| Tarball SHA-256          | `269f988267bc71efe58baf97e8b2da064b5bbbbb8b0eab11e2149049935e1160`                                |
| npm integrity            | `sha512-WZzeDOEtTOBK4Mdsar0IqEU5sMr3vSV2RqkAIzUEV2BHnUfKGyswWFPFwK5EeDo93K3FohSHbLAjj0s1Wzd+dg==` |
| Original decoder SHA-256 | `a3f175fd6f62d142aad94d3bd90f3a30be4e076baf9b6a6fa31c8e84d9d4aa9f`                                |
| Package license SHA-256  | `c0a8512eabe960492fefd4f287523eb3b5ca1518ca37ef0ec83344cd7f089cb8`                                |

Download that exact public npm tarball once to the ignored path
`release/automation/tooling/jpeg-js-0.4.4/source.tgz`, or supply its path explicitly:

```sh
node scripts/generate-catalog-jpeg-validator.mjs --source=/absolute/path/source.tgz
node scripts/generate-catalog-jpeg-validator.mjs --source=/absolute/path/source.tgz --check
```

The generator verifies both archive hashes and the original source/license hashes,
applies only unique known-source patches, and regenerates offline ESM. It installs
no npm dependency and extracts no archive paths to the filesystem. Preserve the
decoder's original Apache copyright/header and the full Apache-2.0 and package BSD
licenses included here. The published upstream source is
<https://github.com/jpeg-js/jpeg-js/tree/v0.4.4>.
