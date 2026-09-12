import { access, lstat, readFile } from 'node:fs/promises';
import { resolveIntent } from './lib/release/intent.mjs';
import { inspectInstalledProbe } from './lib/release/probes-macos.mjs';
import { validateBridgeConfig } from './lib/release/agent-bridge.mjs';
import { bridgeHealth } from './lib/release/dependencies.mjs';

/**
 * The gate between "the code is written" and "a real sandbox release may run".
 *
 * Each dependency here is one the fixtures were allowed to fake during
 * development: the resource probe, the admission socket, the agent bridge. This
 * command refuses to accept a stand-in for any of them, which is the only thing
 * that stops a green fixture suite from being mistaken for a working
 * installation.
 */

export async function inspectAcceptanceDependencies({
  probePath,
  probeDigest,
  leaseSocket,
  bridgeConfigPath
}) {
  const probe = await inspectInstalledProbe({ executable: probePath, digest: probeDigest });
  if (!probe.ok) return { ok: false, code: 'PROBE_UNAVAILABLE', detail: probe.reason ?? null };
  try {
    const socket = await lstat(leaseSocket);
    if (!socket.isSocket()) return { ok: false, code: 'LEASE_SOCKET_UNAVAILABLE' };
  } catch {
    return { ok: false, code: 'LEASE_SOCKET_UNAVAILABLE' };
  }
  try {
    const config = JSON.parse(await readFile(bridgeConfigPath, 'utf8'));
    const valid = validateBridgeConfig(config);
    if (!valid.ok || !valid.value) return valid;
    const bridge = valid.value;
    await access(bridge.executable);
    if (!(await bridgeHealth(bridge.executable)))
      return { ok: false, code: 'AGENT_BRIDGE_UNAVAILABLE' };
  } catch {
    return { ok: false, code: 'AGENT_BRIDGE_UNAVAILABLE' };
  }
  return { ok: true };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const intentPath = process.argv[2];
  if (!intentPath) throw new Error('Usage: node scripts/release-acceptance.mjs <intent.json>');
  const intent = resolveIntent(JSON.parse(await readFile(intentPath, 'utf8')));
  if (intent.targetKind !== 'sandbox')
    throw new Error('TARGET_MISMATCH: acceptance refuses production');
  const result = await inspectAcceptanceDependencies({
    probePath: process.env.SOTY_RELEASE_PROBE,
    probeDigest: process.env.SOTY_RELEASE_PROBE_DIGEST,
    leaseSocket: process.env.SOTY_RELEASE_LEASE_SOCKET,
    bridgeConfigPath: process.env.SOTY_RELEASE_BRIDGE_CONFIG
  });
  if (!result.ok) throw new Error(`ACCEPTANCE_DEPENDENCY_MISSING: ${result.code}`);
  process.stdout.write(
    `${JSON.stringify({ ok: true, runId: intent.runId, target: intent.targetId })}\n`
  );
}
