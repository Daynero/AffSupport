#!/usr/bin/env node
import { runWebOnly, webOnlyBackendPlan } from './release-web-only.mjs';
try {
  if (process.argv.slice(2).some(arg => arg !== '--json' && !arg.startsWith('--backend-plan=')))
    throw new Error('WEB_ONLY_ARGUMENT_INVALID');
  const result = await runWebOnly({
    mode: 'verify-only',
    backendPlanPath: webOnlyBackendPlan(process.argv.slice(2))
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: { code: error instanceof Error ? error.message.split(':')[0] : 'WEB_ONLY_FAILED' } })}\n`
  );
  process.exitCode = 1;
}
