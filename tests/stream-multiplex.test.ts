import { afterEach, describe, expect, it } from 'vitest';
import { ChannelHub, EventChannel } from '../apps/agent/src/server/sse.js';
import { waitFor } from './support/wait.js';

/**
 * One connection carrying every channel.
 *
 * The interface held seven server-sent-event connections at once, one per tool. Seven
 * sockets, seven reconnect timers, and — the part that actually hurt — seven independent
 * opinions about whether the local app is reachable, which is how one page could say
 * "connected" while another offered to install the application.
 *
 * These drive the fan-out directly rather than over HTTP. What is under test is the
 * multiplexing, the caps and the sampling lifecycle; the route that wraps it is a dozen
 * lines and is covered where the rest of the HTTP surface is.
 */

/** A socket that records what was written to it, and can pretend not to drain. */
class RecordingSocket {
  readonly frames: string[] = [];
  writableLength = 0;
  destroyed = false;
  throwOnWrite = false;

  write(payload: string): boolean {
    if (this.throwOnWrite) throw new Error('socket closed');
    this.frames.push(payload);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** Every frame parsed back out, ignoring heartbeats and terminal notices. */
  events(): { channel: string; event: unknown }[] {
    return this.frames
      .filter(frame => frame.startsWith('data: '))
      .map(frame => JSON.parse(frame.slice('data: '.length)));
  }
}

const origins = new Set<string>();
const hubs: ChannelHub[] = [];

afterEach(() => {
  for (const hub of hubs.splice(0)) hub.closeAll();
});

function hub(): ChannelHub {
  const created = new ChannelHub();
  hubs.push(created);
  return created;
}

function socketOf(recording: RecordingSocket) {
  return recording as unknown as NodeJS.WritableStream;
}

describe('one stream, many channels', () => {
  it('replays a snapshot for each channel the moment a client subscribes', () => {
    const created = hub();
    const compressorState = 'idle';
    new EventChannel(origins, () => ({ type: 'state', state: compressorState })).publishOn(
      created,
      'compressor'
    );
    new EventChannel(origins, () => ({ type: 'power', limit: 100 })).publishOn(created, 'power');

    const client = new RecordingSocket();
    created.subscribe(socketOf(client), ['compressor', 'power']);

    // Both snapshots, immediately, each named. Without the replay a page that connects
    // between two updates shows nothing until something happens to change.
    expect(client.events().map(frame => frame.channel)).toEqual(['compressor', 'power']);
    expect(client.events()[0].event).toMatchObject({ state: 'idle' });
  });

  it('delivers only the channels a client asked for', () => {
    const created = hub();
    const compressor = new EventChannel(origins, () => ({ type: 'state' })).publishOn(
      created,
      'compressor'
    );
    const transcription = new EventChannel(origins, () => ({
      type: 'transcription:state'
    })).publishOn(created, 'transcription');

    const client = new RecordingSocket();
    created.subscribe(socketOf(client), ['compressor']);
    const before = client.events().length;

    compressor.broadcast({ type: 'state' });
    transcription.broadcast({ type: 'transcription:state' });

    const delivered = client.events().slice(before);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].channel).toBe('compressor');
  });

  it('keeps the per-tool endpoint working alongside the stream', () => {
    // Both transports, in this release. Removing the seven endpoints would make the agent
    // and the interface have to ship together, and the whole point of the capability flag is
    // that they do not.
    const created = hub();
    const compressor = new EventChannel(origins, () => ({ type: 'state' }));
    compressor.publishOn(created, 'compressor');

    const legacy = new RecordingSocket();
    // Standing in for what `handler` does to a hijacked response.
    (compressor as unknown as { clients: Set<unknown> }).clients.add(legacy);
    const multiplexed = new RecordingSocket();
    created.subscribe(socketOf(multiplexed), ['compressor']);

    compressor.broadcast({ type: 'state' });

    expect(legacy.frames.some(frame => frame.includes('"type":"state"'))).toBe(true);
    expect(multiplexed.events().some(frame => frame.channel === 'compressor')).toBe(true);
  });

  it('stops publishing to a client that has gone', () => {
    const created = hub();
    const compressor = new EventChannel(origins, () => ({ type: 'state' })).publishOn(
      created,
      'compressor'
    );
    const client = new RecordingSocket();
    const detach = created.subscribe(socketOf(client), ['compressor']);
    const before = client.events().length;

    detach();
    compressor.broadcast({ type: 'state' });

    // A subscriber left in the set is a write that throws on every subsequent event, inside
    // the queue's drain loop.
    expect(client.events()).toHaveLength(before);
  });
});

describe('a channel that costs something to produce', () => {
  it('starts when the first client arrives and stops when the last leaves', () => {
    const created = hub();
    const active: boolean[] = [];
    new EventChannel(origins, () => ({ limit: 100 })).publishOn(created, 'power', state =>
      active.push(state)
    );

    const first = new RecordingSocket();
    const second = new RecordingSocket();
    const detachFirst = created.subscribe(socketOf(first), ['power']);
    const detachSecond = created.subscribe(socketOf(second), ['power']);

    // Once on, not once per viewer: measurement is refcounted, so a second panel must not
    // start a second sampler.
    expect(active).toEqual([true]);

    detachFirst();
    expect(active).toEqual([true]);

    detachSecond();
    // And off again when nobody is left. A sampler left running reads the process table on a
    // timer for the rest of the session, for nobody.
    expect(active).toEqual([true, false]);
  });
});

describe('protecting the process from its own subscribers', () => {
  it('drops a reader that has stopped draining', () => {
    const created = hub();
    const compressor = new EventChannel(origins, () => ({ type: 'state' })).publishOn(
      created,
      'compressor'
    );
    const stalled = new RecordingSocket();
    created.subscribe(socketOf(stalled), ['compressor']);

    // A suspended tab, or a laptop that closed mid-run. The writes keep arriving and
    // accumulate in the socket's buffer inside the queue's drain loop — a leak that grows
    // for as long as the run lasts.
    stalled.writableLength = 2_000_000;
    compressor.broadcast({ type: 'state' });

    expect(stalled.destroyed).toBe(true);
    const delivered = stalled.events().length;
    compressor.broadcast({ type: 'state' });
    expect(stalled.events()).toHaveLength(delivered);
  });

  it('drops a subscriber whose socket throws rather than failing the broadcast', () => {
    // `broadcast` runs inside the queue's drain loop. A throw here would strand the rest of
    // the batch, which is a stopped queue caused by a closed browser tab.
    const created = hub();
    const compressor = new EventChannel(origins, () => ({ type: 'state' })).publishOn(
      created,
      'compressor'
    );
    const dead = new RecordingSocket();
    created.subscribe(socketOf(dead), ['compressor']);
    dead.throwOnWrite = true;

    expect(() => compressor.broadcast({ type: 'state' })).not.toThrow();
  });

  it('evicts the oldest connection rather than refusing the newest', async () => {
    const created = hub();
    new EventChannel(origins, () => ({ type: 'state' })).publishOn(created, 'compressor');

    const clients: RecordingSocket[] = [];
    for (let index = 0; index < 9; index += 1) {
      const client = new RecordingSocket();
      clients.push(client);
      created.subscribe(socketOf(client), ['compressor']);
    }

    // Refusing the newest would make the application look broken to the person who just
    // opened a tab, while one they abandoned an hour ago keeps its place.
    const oldest = clients[0];
    await waitFor(() => oldest.destroyed, { describe: 'the oldest subscriber to be evicted' });
    expect(clients.at(-1)?.destroyed).toBe(false);

    // And it is told why, so its reader reconnects instead of sitting on a dead socket.
    expect(oldest.frames.some(frame => frame.includes('event: replaced'))).toBe(true);
  });
});
