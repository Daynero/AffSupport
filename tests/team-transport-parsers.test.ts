import { describe, expect, it } from 'vitest';
import {
  parseTeamAgentPreviewResult,
  parseTeamDownloadGrantResult,
  parseTeamEdgeResult,
  parseTeamFileOperationResult,
  parseTeamOperationSnapshot,
  parseTeamPreviewResult,
  parseTeamProcessStartResult,
  parseTeamTransferGrant,
  parseTeamUploadSession
} from '../packages/shared/src/team/transport.js';

/**
 * These nine functions are the whole boundary between this app and whatever a
 * server — or something impersonating one — sends back. Everything past them is
 * treated as a known shape, so a field they wave through is a field nothing
 * checks again: a `rangeUrl` becomes a fetch, a landing `url` becomes the src of
 * a frame allowed to run scripts, an `allowedActions` list becomes the buttons a
 * viewer is offered.
 *
 * They are tested here for what they refuse, because accepting valid input is
 * the half that fails loudly.
 */

const EXPIRES = '2026-09-01T10:00:00.000Z';
const TICKET = 'a'.repeat(32);
const FINGERPRINT = 'b'.repeat(64);

function grant(patch: Record<string, unknown> = {}) {
  return {
    ticket: TICKET,
    purpose: 'preview_range',
    expiresAt: EXPIRES,
    maxRangeBytes: 1024 * 1024,
    maxUses: 10,
    ...patch
  };
}

describe('the envelope every team call comes back in', () => {
  it('passes a success through with its value untouched', () => {
    expect(parseTeamEdgeResult({ ok: true, value: { anything: 1 } })).toEqual({
      ok: true,
      value: { anything: 1 }
    });
  });

  it('keeps a structured failure it recognises', () => {
    expect(
      parseTeamEdgeResult({ ok: false, error: { code: 'PERMISSION_DENIED', retryable: false } })
    ).toEqual({ ok: false, error: { code: 'PERMISSION_DENIED', retryable: false } });
  });

  it.each([
    ['an unknown error code', { ok: false, error: { code: 'MADE_UP', retryable: false } }],
    [
      'a non-boolean retryable',
      { ok: false, error: { code: 'PERMISSION_DENIED', retryable: 'yes' } }
    ],
    ['a success with no value', { ok: true }],
    ['a bare string', 'nope'],
    ['null', null]
  ])('turns %s into INVALID_RESPONSE rather than trusting it', (_case, value) => {
    // Never a throw and never a pass-through: the caller gets a failure it can
    // render, and one it cannot mistake for a server-sent code.
    expect(parseTeamEdgeResult(value)).toEqual({
      ok: false,
      error: { code: 'INVALID_RESPONSE', retryable: false }
    });
  });
});

describe('an operation snapshot', () => {
  const valid = {
    id: 'op-1',
    teamId: 'team-1',
    kind: 'process',
    state: 'running',
    stage: 'encoding',
    progress: 42,
    sourceMaterialId: 'mat-1',
    resultMaterialId: null,
    errorCode: null,
    retryable: false,
    createdAt: EXPIRES,
    updatedAt: EXPIRES
  };

  it('accepts a well-formed snapshot', () => {
    expect(parseTeamOperationSnapshot(valid)).toMatchObject({ id: 'op-1', progress: 42 });
  });

  it.each([
    ['progress below zero', { progress: -1 }],
    ['progress above a hundred', { progress: 101 }],
    ['a kind it does not know', { kind: 'mine_bitcoin' }],
    ['a state it does not know', { state: 'ascended' }],
    ['an error code it does not know', { errorCode: 'MADE_UP' }],
    ['a missing timestamp', { updatedAt: undefined }]
  ])('refuses one with %s', (_case, patch) => {
    expect(parseTeamOperationSnapshot({ ...valid, ...patch })).toBeNull();
  });
});

describe('a transfer grant', () => {
  it('accepts one within every bound', () => {
    expect(parseTeamTransferGrant(grant())).toMatchObject({ purpose: 'preview_range' });
  });

  it.each([
    ['a ticket too short to have entropy', { ticket: 'short' }],
    ['a ticket long enough to be a payload', { ticket: 'a'.repeat(2049) }],
    ['a purpose it does not know', { purpose: 'read_everything' }],
    ['an unparseable expiry', { expiresAt: 'soon' }],
    ['a range larger than the ceiling', { maxRangeBytes: 33 * 1024 * 1024 }],
    ['a zero range', { maxRangeBytes: 0 }],
    ['a fractional range', { maxRangeBytes: 1.5 }],
    ['more uses than the ceiling', { maxUses: 10_001 }],
    ['no uses at all', { maxUses: 0 }]
  ])('refuses one with %s', (_case, patch) => {
    expect(parseTeamTransferGrant(grant(patch))).toBeNull();
  });
});

describe('a preview result', () => {
  it('accepts media served over http', () => {
    expect(
      parseTeamPreviewResult({
        kind: 'media',
        rangeUrl: 'https://storage.example/range',
        mimeType: 'video/mp4',
        expiresAt: EXPIRES
      })
    ).toMatchObject({ kind: 'media' });
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', '/relative'])(
    'refuses media whose rangeUrl is %s',
    rangeUrl => {
      // This URL is fetched. A scheme that is not http(s) is not a slow preview,
      // it is a different thing happening entirely.
      expect(
        parseTeamPreviewResult({
          kind: 'media',
          rangeUrl,
          mimeType: 'video/mp4',
          expiresAt: EXPIRES
        })
      ).toBeNull();
    }
  );

  it('refuses a transcript claiming more indexed bytes than the ceiling', () => {
    expect(
      parseTeamPreviewResult({
        kind: 'transcript',
        text: 'hello',
        ingestState: 'full',
        truncated: false,
        indexedBytes: 1024 * 1024 + 1,
        sourceVersion: null,
        allowedActions: ['download']
      })
    ).toBeNull();
  });

  it('refuses an agent preview whose grant is for something else', () => {
    expect(
      parseTeamPreviewResult({
        kind: 'agent',
        operationId: 'op-1',
        transferGrant: grant({ purpose: 'download_range' }),
        previewKind: 'archive'
      })
    ).toBeNull();
  });

  it('refuses an unavailable preview that offers editing anyway', () => {
    // "We cannot show you this" and "you may edit it" are contradictory, and the
    // combination is how an edit control appears for something never loaded.
    expect(
      parseTeamPreviewResult({
        kind: 'unavailable',
        reason: 'corrupt',
        allowedActions: ['download', 'edit']
      })
    ).toBeNull();
  });

  it('refuses an action list it does not recognise', () => {
    expect(
      parseTeamPreviewResult({
        kind: 'unavailable',
        reason: 'corrupt',
        allowedActions: ['delete_everything']
      })
    ).toBeNull();
  });
});

describe('a preview the local agent rendered', () => {
  const landing = {
    kind: 'landing',
    operationId: 'op-1',
    url: 'http://127.0.0.1:43120/preview/1',
    sandbox: 'allow-scripts',
    warning: null,
    screenshotAvailable: true,
    validation: {
      sourceVersion: '1',
      sourceChecksum: null,
      fingerprint: FINGERPRINT,
      landingRoot: '/landing'
    }
  };

  it('accepts a landing served from loopback', () => {
    expect(parseTeamAgentPreviewResult(landing)).toMatchObject({ kind: 'landing' });
  });

  it.each([
    ['a remote host', 'https://evil.example/preview/1'],
    ['a loopback name rather than the address', 'http://localhost:43120/preview/1'],
    ['a host that merely starts the same way', 'http://127.0.0.1.evil.example/x'],
    ['no port', 'http://127.0.0.1/preview/1']
  ])('refuses a landing url that is %s', (_case, url) => {
    // This URL becomes the src of a frame that is allowed to run scripts. Only
    // the agent on this machine may fill it.
    expect(parseTeamAgentPreviewResult({ ...landing, url })).toBeNull();
  });

  it('refuses a landing that asks for a wider sandbox', () => {
    expect(
      parseTeamAgentPreviewResult({ ...landing, sandbox: 'allow-scripts allow-same-origin' })
    ).toBeNull();
  });

  it.each([
    ['too short', 'abc'],
    ['not hexadecimal', 'z'.repeat(64)]
  ])('refuses a fingerprint that is %s', (_case, fingerprint) => {
    expect(
      parseTeamAgentPreviewResult({
        ...landing,
        validation: { ...landing.validation, fingerprint }
      })
    ).toBeNull();
  });

  it('accepts an archive manifest and keeps its entries', () => {
    const parsed = parseTeamAgentPreviewResult({
      kind: 'archive',
      operationId: 'op-1',
      truncated: false,
      entries: [{ path: 'index.html', directory: false, sizeBytes: 12 }]
    });

    expect(parsed).toMatchObject({ kind: 'archive', entries: [{ path: 'index.html' }] });
  });

  it.each([
    ['an entry with a negative size', [{ path: 'a', directory: false, sizeBytes: -1 }]],
    ['an entry that is not a record', ['a']],
    ['an entry missing its path', [{ directory: false, sizeBytes: 1 }]]
  ])('refuses an archive with %s', (_case, entries) => {
    expect(
      parseTeamAgentPreviewResult({
        kind: 'archive',
        operationId: 'op-1',
        truncated: false,
        entries
      })
    ).toBeNull();
  });

  it('refuses an archive that admits it is truncated', () => {
    // A manifest missing entries would render as a complete listing.
    expect(
      parseTeamAgentPreviewResult({
        kind: 'archive',
        operationId: 'op-1',
        truncated: true,
        entries: []
      })
    ).toBeNull();
  });
});

describe('an upload session', () => {
  const session = {
    operationId: 'op-1',
    state: 'pending',
    sessionUri: 'https://upload.example/session',
    sessionUnavailable: false,
    name: 'clip.mp4',
    chunkMultiple: 256 * 1024,
    expiresAt: EXPIRES,
    relayUrl: null
  };

  it('accepts a session over https', () => {
    expect(parseTeamUploadSession(session)).toMatchObject({ operationId: 'op-1' });
  });

  it.each([
    ['a session uri that is not https', { sessionUri: 'http://upload.example/session' }],
    ['a chunk size the resumable protocol does not use', { chunkMultiple: 1024 }],
    ['a state it does not know', { state: 'finished' }],
    ['an unparseable expiry', { expiresAt: 'later' }]
  ])('refuses one with %s', (_case, patch) => {
    expect(parseTeamUploadSession({ ...session, ...patch })).toBeNull();
  });
});

describe('the result of a file operation', () => {
  it('accepts a completed one', () => {
    expect(
      parseTeamFileOperationResult({
        operationId: 'op-1',
        state: 'succeeded',
        materialId: 'mat-1',
        reused: false
      })
    ).toMatchObject({ materialId: 'mat-1' });
  });

  it('refuses a state it does not know', () => {
    expect(
      parseTeamFileOperationResult({
        operationId: 'op-1',
        state: 'mostly_done',
        materialId: null,
        reused: false
      })
    ).toBeNull();
  });
});

describe('a download grant', () => {
  it('accepts a browser download marked as an attachment', () => {
    expect(
      parseTeamDownloadGrantResult({
        kind: 'browser',
        rangeUrl: 'https://storage.example/file',
        expiresAt: EXPIRES,
        disposition: 'attachment'
      })
    ).toMatchObject({ kind: 'browser' });
  });

  it('refuses a browser download that would render inline', () => {
    // `inline` on a downloaded file is how something arrives as a page rather
    // than as a file the viewer chose to open.
    expect(
      parseTeamDownloadGrantResult({
        kind: 'browser',
        rangeUrl: 'https://storage.example/file',
        expiresAt: EXPIRES,
        disposition: 'inline'
      })
    ).toBeNull();
  });

  it('accepts an agent download whose grant says download_range', () => {
    expect(
      parseTeamDownloadGrantResult({
        kind: 'agent',
        transferUrl: 'http://127.0.0.1:43120/transfer',
        grant: grant({ purpose: 'download_range' })
      })
    ).toMatchObject({ kind: 'agent' });
  });

  it('refuses an agent download carrying a grant for a different purpose', () => {
    expect(
      parseTeamDownloadGrantResult({
        kind: 'agent',
        transferUrl: 'http://127.0.0.1:43120/transfer',
        grant: grant({ purpose: 'finalize' })
      })
    ).toBeNull();
  });
});

describe('starting a processing run', () => {
  const start = {
    operationId: 'op-1',
    state: 'pending',
    sourceGrant: grant({ purpose: 'process_input' }),
    finalizeGrant: grant({ purpose: 'finalize' }),
    agentContractVersion: 1
  };

  it('accepts a start whose two grants each say what they are for', () => {
    expect(parseTeamProcessStartResult(start)).toMatchObject({ agentContractVersion: 1 });
  });

  it('refuses one whose grants are swapped', () => {
    expect(
      parseTeamProcessStartResult({
        ...start,
        sourceGrant: grant({ purpose: 'finalize' }),
        finalizeGrant: grant({ purpose: 'process_input' })
      })
    ).toBeNull();
  });

  it.each([
    ['a contract version below one', { agentContractVersion: 0 }],
    ['a fractional contract version', { agentContractVersion: 1.5 }],
    ['a state it does not know', { state: 'succeeded' }]
  ])('refuses one with %s', (_case, patch) => {
    expect(parseTeamProcessStartResult({ ...start, ...patch })).toBeNull();
  });
});
