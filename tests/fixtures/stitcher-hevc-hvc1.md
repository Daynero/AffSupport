# Synthetic HEVC source for stitcher rejection

`stitcher-hevc-hvc1.mp4` contains two seconds of FFmpeg testsrc2 at 320×320, 30 fps, no audio, HEVC with an hvc1 tag. It contains no user media.

The shipping FFmpeg can decode HEVC but has no libx265 encoder. This checked-in input lets the rejection test exercise the shipping runtime without requiring an encoder that the product does not use.

Generated with the installed Homebrew FFmpeg 9.0.1:

```sh
ffmpeg -hide_banner -loglevel error -n -f lavfi \
  -i testsrc2=size=320x320:rate=30:duration=2 \
  -c:v libx265 -preset ultrafast -threads 1 \
  -x265-params pools=1:frame-threads=1 -tag:v hvc1 -an \
  tests/fixtures/stitcher-hevc-hvc1.mp4
```

Size: 89977 bytes. SHA-256: `3703414fc42f75aa707154c9eee0db86c8e745a2f2c5b3c37e5eea1898ebaead`.

The integration test copies it to its own temporary directory and verifies that probing and refusing it leave its bytes unchanged.
