import { execFileSync } from 'node:child_process';
import { watchWorkflow } from './lib/release/github-watch.mjs';

const runId = process.argv[2];
const pollSeconds = Number.parseInt(process.env.RELEASE_POLL_SECONDS ?? '30', 10);

if (!runId || !/^\d+$/.test(runId)) {
  console.error('Usage: npm run release:watch -- <run-id>');
  process.exit(2);
}

if (!Number.isFinite(pollSeconds) || pollSeconds < 15) {
  console.error('RELEASE_POLL_SECONDS must be an integer of at least 15');
  process.exit(2);
}

const result = await watchWorkflow({
  pollMs: pollSeconds * 1000,
  read: async () => {
    let run;
    try {
      run = JSON.parse(
        execFileSync('gh', ['run', 'view', runId, '--json', 'status,conclusion,jobs,url'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        })
      );
    } catch (error) {
      // execFile attaches the child's output to the error it throws.
      const stderr = /** @type {{ stderr?: { toString(): string } }} */ (error)?.stderr
        ?.toString()
        .trim();
      console.error(stderr || `Could not read GitHub Actions run ${runId}`);
      process.exit(2);
    }

    return run;
  },
  onState: ({ summary }) => console.log(`${new Date().toISOString()} ${summary}`)
});
if (result.run?.url) console.log(result.run.url);
process.exit(result.ok ? 0 : 1);
