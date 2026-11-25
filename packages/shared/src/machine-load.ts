import { AGENT_TOOL_CONTRACTS, type ToolContracts } from './release.js';

/* ── How busy the whole computer is ─────────────────────────────────────── */

/**
 * The name the reading travels under on the agent's multiplexed stream.
 *
 * Its own channel rather than a field of the power state: the power channel's sampler walks
 * Soty's process tree, which is worth paying for while the throttle panel is open and not
 * while a header is merely on screen. This one costs a counter read a second.
 */
export const MACHINE_LOAD_CHANNEL = 'machine-load';

/** Which of the two figures is the larger, and so the one the header shows. */
export type MachineLoadSource = 'cpu' | 'gpu';

/**
 * The machine's load: every process, not only Soty's.
 *
 * A discriminated union for the same reason `PowerSample` is one: "not measured yet" and
 * "0%" are different claims, and a caller holding this type cannot render the first as the
 * second.
 */
export type MachineLoad =
  | {
      availability: 'ok';
      /** The larger of the two figures below, 0–100, whole percent. */
      percent: number;
      /** Busy share of every processor core together, 0–100, whole percent. */
      cpuPercent: number;
      /** The graphics device's utilisation, 0–100, or null where it cannot be read. */
      gpuPercent: number | null;
      source: MachineLoadSource;
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
export function machineLoadFrom(input: {
  cpuPercent: number;
  gpuPercent: number | null;
  sampledAt: string;
}): MachineLoad {
  const cpu = clampLoadPercent(input.cpuPercent);
  const gpu = input.gpuPercent === null ? null : clampLoadPercent(input.gpuPercent);
  const gpuLeads = gpu !== null && gpu > cpu;
  return {
    availability: 'ok',
    percent: gpuLeads ? gpu : cpu,
    cpuPercent: cpu,
    gpuPercent: gpu,
    source: gpuLeads ? 'gpu' : 'cpu',
    sampledAt: input.sampledAt
  };
}

function clampLoadPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Whether the connected agent publishes the machine's load.
 *
 * Read from the contract like the other capabilities the interface asks about rather than
 * serves as a page: an agent from before this answers no, and the header button stays the
 * plain bolt it always was.
 */
export function machineLoadSupported(contracts: ToolContracts | null): boolean {
  return (contracts?.machineLoad ?? 0) >= AGENT_TOOL_CONTRACTS.machineLoad;
}
