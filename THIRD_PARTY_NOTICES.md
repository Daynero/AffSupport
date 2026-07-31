# Third-party notices

## FFmpeg 7.1.1 and x264

The application bundles arm64 `ffmpeg` and `ffprobe`, built locally from the official FFmpeg 7.1.1 release source and VideoLAN x264 commit `0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee`. Build flags include `--enable-gpl --enable-libx264 --disable-shared --enable-static --disable-ffplay --disable-sdl2`; `--enable-nonfree` is not used. The resulting programs are distributed under GNU GPL version 2 or later. Complete corresponding source archives are included in `Contents/Resources/licenses/sources/` inside the app bundle.

- FFmpeg source: https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz
- FFmpeg project and license: https://ffmpeg.org/
- x264 source: https://code.videolan.org/videolan/x264
- x264 license: GNU GPL version 2 or later

Build artifact SHA-256 values:

- `ffmpeg`: `2a1ea219bd952fabaf858a070f231f31f7bacfd06c5215a62bd416c3eaf56178`
- `ffprobe`: `82c5020f737a87410c0888623ebd1235cb3afc08dcdb2bbe100a27aa4e5c151e`
- FFmpeg source: `733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1`
- x264 source: `be32b1e787ca8e905c10b956d2a5be0b99847deea2ff53be0cd93e488cd90323`

No FFmpeg or FFprobe binary from Homebrew is included.

## Node.js

The application bundles an arm64 Node.js runtime. Node.js is distributed under the MIT license and includes components under compatible licenses. Source and license information: https://github.com/nodejs/node and https://raw.githubusercontent.com/nodejs/node/main/LICENSE.

## Playwright and Chromium Headless Shell

Landing previews are rendered locally with Playwright 1.62.1 and its pinned Chromium Headless Shell revision 1234 (Chrome for Testing 151.0.7922.34). Playwright is distributed under the Apache License 2.0. The bundled browser directory retains `LICENSE.headless_shell`, which contains the Chromium BSD license and the notices for Chromium's third-party components.

- Playwright source and license: https://github.com/microsoft/playwright
- Chromium source and license information: https://www.chromium.org/Home/

## Supabase JavaScript client

The web application uses `@supabase/supabase-js`, distributed under the MIT license. Source and license information: https://github.com/supabase/supabase-js.

## Google Sign-In asset

The Google "G" asset used by the sign-in button is an unmodified current asset from Google's official Sign in with Google asset bundle and is displayed according to Google's identity branding guidance. Source: https://developers.google.com/identity/branding-guidelines.

## TranslateGemma (local translation model)

Wishly can download a quantized **TranslateGemma 4B IT** model on demand for local translation. The model is not committed to this repository and is not embedded in the application package. Translation runs through the pinned local llama.cpp runtime; transcript text and translation requests are not sent to a network service.

> Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms

TranslateGemma is licensed under the **Gemma Terms of Use** (https://ai.google.dev/gemma/terms), not an OSI open-source license, and is subject to the Gemma Prohibited Use Policy (https://ai.google.dev/gemma/prohibited_use_policy). The app presents these terms before the first composite model download. The package includes `GEMMA_TERMS.md`, `GEMMA_PROHIBITED_USE_POLICY.md`, and `NOTICE-Gemma.txt`.

Pinned source and artifact:

- Base model: `google/translategemma-4b-it`
- Base revision: `10042cb0e6e7fdce748996a71dc3dc432a4e0c89`
- Base source: https://huggingface.co/google/translategemma-4b-it
- Modified artifact: `translategemma-4b-it-Q4_K_M.gguf`
- Quantization: GGUF `Q4_K_M`
- Immutable conversion repository revision: `ctc88haha/translategemma-4b-it-Q4_K_M-GGUF@74307c4cbd921b1f524ec90113e3c4cf0466e98c`
- Conversion/validation llama.cpp revision recorded by the artifact publisher: `2048b5913d51beab82dfe29955f9008130b936c0`
- Exact size: `2,489,909,120` bytes
- SHA-256: `8040937f77f3c0612461d833cdf7696282444c7aded00250b3924be9652f2055`

Reconstruction/verification recipe (after separately accepting the Gemma terms and obtaining the exact base snapshot):

```bash
git -C llama.cpp checkout 2048b5913d51beab82dfe29955f9008130b936c0
python3 llama.cpp/convert_hf_to_gguf.py google-translategemma-4b-it-10042cb \
  --outfile translategemma-4b-it-F16.gguf --outtype f16
llama.cpp/build/bin/llama-quantize \
  translategemma-4b-it-F16.gguf translategemma-4b-it-Q4_K_M.gguf Q4_K_M
shasum -a 256 translategemma-4b-it-Q4_K_M.gguf
```

The exact byte size and SHA-256 above are authoritative: Wishly downloads to `.part`, checks both values, validates the GGUF container, and atomically installs only an exact match. The artifact is a community conversion rather than an official Google GGUF. Before pinning it, Wishly independently inspected its TranslateGemma/Gemma 3 metadata and embedded chat template and exercised the exact hash through the opt-in real local translation smoke test. It is not affiliated with, endorsed by, or sponsored by Google.

## llama.cpp (local model runtime)

Wishly downloads and verifies the official Apple Silicon llama.cpp release archive on demand:

- Project: https://github.com/ggml-org/llama.cpp
- License: MIT (copied as `llama.cpp-LICENSE`)
- Release: `b10092`
- Source revision: `3ce7da2c852c538c4c5f9806da27029cf8c9cc4a`
- Archive: `llama-b10092-bin-macos-arm64.tar.gz`
- Exact size: `10,612,780` bytes
- SHA-256: `f3ec2351e06322478e3f38f23f5339cd834cca5e3740f334ce2bdc5de95f90e0`

The local servers bind authenticated private Unix-domain sockets, not TCP ports, and disable prompt logging.

## Multilingual E5 Small (word/phrase alignment)

Semantic source↔translation alignment uses `intfloat/multilingual-e5-small`, whose pinned upstream model-card metadata declares `license: mit`, through the same pinned local llama.cpp runtime. The model is downloaded on demand and is not committed to Git. The pinned repository does not contain a separate LICENSE file or copyright-holder line, so Wishly packages an explicit provenance notice plus the standard MIT text as `multilingual-e5-small-MIT.txt` rather than inventing an upstream copyright notice.

- Base model revision: `intfloat/multilingual-e5-small@614241f622f53c4eeff9890bdc4f31cfecc418b3`
- GGUF conversion revision: `keisuke-miyako/multilingual-e5-small-gguf-q4_k_m@3251974431b4ec1b9f6b0335edebedc505ec36d8`
- Modified artifact: `multilingual-e5-small-Q4_K_M.gguf` (upstream filename uses `Q4_k_m`)
- Quantization: GGUF `Q4_K_M`
- Exact size: `124,350,304` bytes
- SHA-256: `6661b6e1ccb06e3044e2cd7aa25ca0b837ef7224a2cb5aff3a9e6807c60d01f1`

Alignment confidence is derived from local multilingual embeddings and coverage. If phrase alignment is missing or fails, Wishly falls back to the corresponding whole segment with an explicitly capped approximate/yellow score.
