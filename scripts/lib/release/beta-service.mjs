export function betaStopPolicy(record, listenerPids, { agentPort, webPort }) {
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.stackStarted !== true ||
    !Array.isArray(record.ports)
  ) {
    return { ok: false, code: 'BETA_SERVICE_BORROWED' };
  }
  for (const [port, pids] of Object.entries(listenerPids)) {
    const expected =
      Number(port) === agentPort
        ? record.agentPid
        : Number(port) === webPort
          ? record.webPid
          : null;
    if (!Array.isArray(pids) || pids.some(pid => pid !== expected)) {
      return { ok: false, code: 'BETA_SERVICE_BORROWED', port: Number(port) };
    }
  }
  return { ok: true };
}
