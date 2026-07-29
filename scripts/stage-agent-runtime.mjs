// Thin CLI over scripts/lib/agent-staging.mjs — the macOS packaging entry
// point (scripts/package-mac.sh calls it with the app's Resources/agent dir).
import { stageAgentRuntime } from './lib/agent-staging.mjs';

const destinationArgument = process.argv[2];

if (!destinationArgument) {
  process.stderr.write('Usage: node scripts/stage-agent-runtime.mjs <destination>\n');
  process.exit(1);
}

const manifest = await stageAgentRuntime(destinationArgument);

process.stdout.write(
  `Staged ${manifest.dependencyCount} production dependency packages for the Agent.\n`
);
