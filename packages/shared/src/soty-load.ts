import { AGENT_TOOL_CONTRACTS, type ToolContracts } from './release.js';
import type { PowerActivity } from './types.js';

/* ── How hard Soty itself is working the computer ───────────────────────── */

/**
 * The name the reading travels under on the agent's multiplexed stream.
 *
 * Still `machine-load`, though it no longer is one: revision 1 of the channel carried the
 * whole computer's load, and the interface already released (1.7.2) subscribes by this name.
 * Keeping it means that interface, talking to a newer agent, shows Soty's own figure in the
 * same place — the fix reaches it too — rather than losing the meter until it is promoted.
 *
 * Its own channel rather than a field of the power state: the power channel carries the
 * limit and the panel's state, and is read while the panel is open; this one runs while the
 * header is merely on screen, and so must cost close to nothing when Soty is idle.
 */
export const SOTY_LOAD_CHANNEL = 'machine-load';

/** Which of the two figures is the larger, and so the one the header shows. */
export type SotyLoadSource = 'cpu' | 'gpu';

/**
 * Soty's own load: the agent and every process it started (FFmpeg, whisper, the stitcher,
 * Playwright's Chromium and their descendants), as a share of the whole computer.
 *
 * Not the machine's. A browser, a video call or a game is not Soty working, and a button
 * that showed them as a percentage next to Soty's name — while the panel beneath it said
 * "Soty is idle — 0%" — was two contradictory claims about the same moment.
 *
 * A discriminated union for the same reason `PowerSample` is one: "not measured yet" and
 * "0%" are different claims, and a caller holding this type cannot render the first as the
 * second.
 */
export type SotyLoad =
  | {
      availability: 'ok';
      /** The larger of the two figures below, 0–100, whole percent. */
      percent: number;
      /** Soty's processor time as a share of every core together, 0–100, whole percent. */
      cpuPercent: number;
      /**
       * Soty's share of the graphics processor, 0–100, or null where this platform cannot
       * attribute graphics work to a process. Never the device's figure.
       */
      gpuPercent: number | null;
      source: SotyLoadSource;
      /** Whether Soty has work under way, from the same moment as the figures. */
      activity: PowerActivity;
      sampledAt: string;
    }
  | {
      availability: 'warming-up' | 'unsupported' | 'error';
      sampledAt: string;
    };

/**
 * Puts the two figures together. The single place the "larger of the two" rule lives, so
 * the agent's monitor and any test fixture cannot disagree about what `percent` means.
 */
export function sotyLoadFrom(input: {
  cpuPercent: number;
  gpuPercent: number | null;
  activity: PowerActivity;
  sampledAt: string;
}): SotyLoad {
  const cpu = clampLoadPercent(input.cpuPercent);
  const gpu = input.gpuPercent === null ? null : clampLoadPercent(input.gpuPercent);
  const gpuLeads = gpu !== null && gpu > cpu;
  return {
    availability: 'ok',
    percent: gpuLeads ? gpu : cpu,
    cpuPercent: cpu,
    gpuPercent: gpu,
    source: gpuLeads ? 'gpu' : 'cpu',
    activity: input.activity,
    sampledAt: input.sampledAt
  };
}

function clampLoadPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Whether the connected agent publishes Soty's own load.
 *
 * Revision 2 of `machineLoad`. An agent at revision 1 (1.7.2) publishes the whole
 * computer's load on the same channel, and the interface must not show that figure as
 * Soty's, so it answers no here and the header button stays the plain bolt.
 */
export function sotyLoadSupported(contracts: ToolContracts | null): boolean {
  return (contracts?.machineLoad ?? 0) >= AGENT_TOOL_CONTRACTS.machineLoad;
}
