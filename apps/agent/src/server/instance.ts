import { randomUUID } from 'node:crypto';

/** Per-boot metadata shared by health, journal capture and operation correlation. */
export function createAgentInstance() {
  return { instanceId: randomUUID(), startedAt: new Date().toISOString() };
}
