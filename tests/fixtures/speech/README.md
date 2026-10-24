# Synthetic speech fixture

`synthetic-en.wav` is synthetic English speech generated locally with the macOS Samantha
system voice at 165 words/minute, then converted by FFmpeg to mono PCM signed 16-bit,
16 kHz. No user recording, network TTS or third-party speech sample is used.

Spoken text: “Today we verify that every highlighted word follows the audio smoothly
without waiting and jumping forward.”

The committed audio lets the same real Whisper integration test run on macOS and Windows.
The test must produce recognized content and monotonic word timestamps; probing a sine
wave alone is not transcription evidence. Model/binary requirements remain explicit.
