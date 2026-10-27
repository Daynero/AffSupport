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

## whisper.cpp and ggml

Video transcription runs locally through whisper.cpp 1.9.1 (which embeds ggml), distributed under the MIT license. Source and license: https://github.com/ggml-org/whisper.cpp and https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE.

- macOS bundles a locally compiled arm64 build of that version (Metal backend), statically linked.
- Windows bundles the official `whisper-bin-x64.zip` release build of the same version, which links `whisper.dll` and the `ggml*.dll` set; those shared libraries are installed next to `whisper-cli.exe`.

Speech is segmented with the Silero VAD ggml model `ggml-silero-v5.1.2.bin` (MIT). The identical file, byte for byte, ships on both platforms. Source and license: https://github.com/snakers4/silero-vad.

## Windows-specific bundled builds

The Windows package bundles different builds from the macOS one. Exact provenance for every bundled third-party file — upstream URL, version, license and sha256 — is recorded in `packaging/windows/inputs.json`, which the build verifies before use.

- Node.js: official 24.13.0 Windows x64 distribution (MIT), same version as the macOS package.
- whisper.cpp: see above.
- FFmpeg and FFprobe: compiled for win64 by `.github/workflows/release-windows.yml` from the official FFmpeg 7.1.1 release tarball and VideoLAN x264 commit `0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee` — the same version and revision the macOS binaries are built from — with `--enable-gpl --enable-libx264 --disable-shared --enable-static`. No third-party build is bundled: no static win64 GPL build of the 7.1.x line is still published anywhere, and a different version would put Windows encoding out of step with macOS. The complete corresponding source archives for both are staged into `licenses/sources/` inside the installed application, exactly as the macOS bundle does.

## Playwright and Chromium Headless Shell

Landing previews are rendered locally with Playwright 1.62.1 and its pinned Chromium Headless Shell revision 1234 (Chrome for Testing 151.0.7922.34). Playwright is distributed under the Apache License 2.0. The bundled browser directory retains `LICENSE.headless_shell`, which contains the Chromium BSD license and the notices for Chromium's third-party components.

- Playwright source and license: https://github.com/microsoft/playwright
- Chromium source and license information: https://www.chromium.org/Home/

## Supabase JavaScript client

The web application uses `@supabase/supabase-js`, distributed under the MIT license. Source and license information: https://github.com/supabase/supabase-js.

## Google Sign-In asset

The Google "G" asset used by the sign-in button is an unmodified current asset from Google's official Sign in with Google asset bundle and is displayed according to Google's identity branding guidance. Source: https://developers.google.com/identity/branding-guidelines.
