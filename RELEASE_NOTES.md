# v0.1.0-test

Private, non-notarized Apple Silicon test build. Video selection, estimation, queueing and compression happen locally; video data is never uploaded.

Known limitations: macOS arm64 only; Chrome may request Local Network Access; Safari may block HTTPS-to-HTTP loopback, in which case use **Open local compressor**; no automatic updates; one agent and one encode at a time. See `TESTER_GUIDE.md` for the macOS warning.
