import { expect, it } from 'vitest';
import { heldPacketCadence } from '../apps/agent/src/ffmpeg/tools';

const packet = (time: number, duration: number) => ({ pts_time: time, duration_time: duration });

it('reads one retained body frame before a forty-minute sparse hold', () => {
  expect(heldPacketCadence([packet(0, 1 / 24), packet(1 / 24, 8.2)])).toBe(24);
});

it('finds a moving cadence between leading and trailing holds in presentation order', () => {
  expect(
    heldPacketCadence([
      packet(2 + 2 / 30, 1),
      packet(0, 2),
      packet(2 + 1 / 30, 1 / 30),
      packet(2, 1 / 30)
    ])
  ).toBe(30);
});

it('does not call ordinary variable timing or separated moving regions a held body', () => {
  expect(
    heldPacketCadence([packet(0, 1 / 30), packet(1 / 30, 1 / 24), packet(0.075, 1)])
  ).toBeNull();
  expect(
    heldPacketCadence([packet(0, 1 / 30), packet(1 / 30, 1), packet(1 + 1 / 30, 1 / 30)])
  ).toBeNull();
});

it('refuses missing, contradictory, or insufficient packet timing', () => {
  expect(heldPacketCadence([{ pts_time: 0 }, packet(1 / 24, 8.2)])).toBeNull();
  expect(heldPacketCadence([packet(0, 1 / 24), packet(1, 8.2)])).toBeNull();
  expect(heldPacketCadence([packet(0, 1 / 24)])).toBeNull();
  expect(
    heldPacketCadence([{ pts_time: null, duration_time: 1 / 24 }, packet(1 / 24, 8.2)])
  ).toBeNull();
  expect(heldPacketCadence([packet(0, Number.MIN_VALUE), packet(Number.MIN_VALUE, 1)])).toBeNull();
});
