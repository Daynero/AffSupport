import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_INDEX_MAX_BYTES } from '../packages/shared/src/team/contract';
import {
  ingestTranscript,
  transcriptEditorEligibility
} from '../packages/shared/src/team/transcript';
import {
  catalogTranscriptTransition,
  isTranscriptCommitCurrent,
  tombstoneTranscriptSnapshot
} from '../supabase/functions/catalog-sync/state';

const encoder = new TextEncoder();

describe('bounded transcript ingestion', () => {
  it('accepts a UTF-8 BOM without indexing it', () => {
    const body = encoder.encode('Привіт, world');
    const input = new Uint8Array(body.byteLength + 3);
    input.set([0xef, 0xbb, 0xbf]);
    input.set(body, 3);
    expect(ingestTranscript(input, { extension: 'TXT', totalBytes: input.byteLength })).toEqual({
      state: 'full',
      text: 'Привіт, world',
      truncated: false,
      indexedBytes: body.byteLength,
      errorCode: null
    });
  });

  it('trims only an incomplete trailing code point at the 1 MiB boundary', () => {
    const prefix = new Uint8Array(TRANSCRIPT_INDEX_MAX_BYTES - 1).fill('a'.charCodeAt(0));
    const emoji = encoder.encode('🙂');
    const input = new Uint8Array(prefix.byteLength + emoji.byteLength);
    input.set(prefix);
    input.set(emoji, prefix.byteLength);
    const result = ingestTranscript(input, { extension: 'txt', totalBytes: input.byteLength });
    expect(result.state).toBe('truncated');
    expect(result.indexedBytes).toBe(TRANSCRIPT_INDEX_MAX_BYTES - 1);
    expect(result.text?.endsWith('a')).toBe(true);
  });

  it.each([
    [new Uint8Array([0x61, 0, 0x62]), 'NUL_BYTE'],
    [new Uint8Array([0x61, 0xc3, 0x28]), 'INVALID_UTF8']
  ] as const)('marks unsafe bytes unavailable without returning text', (input, errorCode) => {
    expect(ingestTranscript(input, { extension: 'txt' })).toMatchObject({
      state: 'invalid_encoding',
      text: null,
      indexedBytes: 0,
      errorCode
    });
  });

  it('extracts safe SRT/VTT cue text while retaining unknown malformed lines literally', () => {
    const srt = encoder.encode(
      '1\n00:00:01,000 --> 00:00:02,000\n<b>Hello</b>\n\nMALFORMED CONTROL\nLiteral line'
    );
    const vtt = encoder.encode(
      'WEBVTT\n\nNOTE private cue note\nignored\n\n00:01.000 --> 00:02.000 position:20%\n<i>Visible</i>'
    );
    expect(ingestTranscript(srt, { extension: 'srt' }).text).toBe(
      'Hello\nMALFORMED CONTROL\nLiteral line'
    );
    expect(ingestTranscript(vtt, { extension: 'vtt' }).text).toBe('Visible');
  });

  it('keeps direct editing limited to complete bounded TXT', () => {
    expect(
      transcriptEditorEligibility({ extension: 'txt', sizeBytes: 20, ingestState: 'full' })
    ).toEqual({ eligible: true });
    expect(
      transcriptEditorEligibility({ extension: 'srt', sizeBytes: 20, ingestState: 'full' })
    ).toEqual({ eligible: false, reason: 'unsupported_format' });
    expect(
      transcriptEditorEligibility({
        extension: 'txt',
        sizeBytes: TRANSCRIPT_INDEX_MAX_BYTES + 1,
        ingestState: 'truncated'
      })
    ).toEqual({ eligible: false, reason: 'too_large' });
  });
});

describe('version-bound transcript catalog state', () => {
  const previous = {
    driveVersion: '7',
    checksum: 'checksum-7',
    mimeType: 'text/plain',
    extension: 'txt'
  };

  it('clears and requeues text when any source identity field changes', () => {
    expect(catalogTranscriptTransition(previous, { ...previous, driveVersion: '8' })).toEqual({
      clearText: true,
      queueIngest: true
    });
    expect(catalogTranscriptTransition(previous, previous)).toEqual({
      clearText: false,
      queueIngest: false
    });
  });

  it('discards a late ingest commit after MIME, extension, checksum, or version changed', () => {
    expect(isTranscriptCommitCurrent(previous, previous)).toBe(true);
    expect(isTranscriptCommitCurrent(previous, { ...previous, checksum: 'checksum-8' })).toBe(
      false
    );
  });

  it('tombstones searchable text while preserving safe provenance identity', () => {
    expect(
      tombstoneTranscriptSnapshot({
        materialId: 'material-id',
        provenanceId: 'link-id',
        transcriptText: 'must disappear',
        lifecycle: 'active'
      })
    ).toEqual({
      materialId: 'material-id',
      provenanceId: 'link-id',
      transcriptText: null,
      lifecycle: 'missing',
      transcriptIngestState: 'unavailable'
    });
  });
});
