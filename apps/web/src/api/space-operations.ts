/**
 * 057 (T035): which tool runs this page opened in an R2 space.
 *
 * `/process/start` answers the same grants for either storage; only the storage decides where
 * the agent reads the source and writes the result. `teamApi.startProcess` routes an R2 space to
 * `space-storage` and records the run here, and `startTeamAgentProcess` reads it to hand the
 * agent the space-storage endpoints and to require the agent contract that speaks R2. A module of
 * its own, with no imports, so the transport (`client.ts`) and the team API (`team.ts`) can both
 * read it without importing each other.
 */
const spaceRuns = new Set<string>();
const LIMIT = 500;

export function rememberSpaceRun(operationId: string): void {
  if (spaceRuns.size >= LIMIT) spaceRuns.delete(spaceRuns.values().next().value as string);
  spaceRuns.add(operationId);
}

export function isSpaceRun(operationId: string): boolean {
  return spaceRuns.has(operationId);
}

/** The space-storage endpoints the agent is given for an R2 run or save. */
export function spaceStorageAgentEndpoints(supabaseUrl: string): {
  transferUrl: string;
  cloudBaseUrl: string;
} {
  const cloudBaseUrl = `${supabaseUrl.replace(/\/$/u, '')}/functions/v1/space-storage`;
  return { transferUrl: `${cloudBaseUrl}/agent/source`, cloudBaseUrl };
}
