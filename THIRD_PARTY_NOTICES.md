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
