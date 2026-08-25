import { execFileSync } from 'node:child_process';

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

let previousSummary = '';

while (true) {
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

  const active = run.jobs
    .flatMap(job =>
      job.steps
        .filter(step => step.status === 'in_progress')
        .map(step => `${job.name}: ${step.name}`)
    )
    .join(' | ');
  const summary = [run.status, run.conclusion, active].filter(Boolean).join(' — ');

  if (summary !== previousSummary) {
    console.log(`${new Date().toISOString()} ${summary}`);
    previousSummary = summary;
  }

  if (run.status === 'completed') {
    console.log(run.url);
    process.exit(run.conclusion === 'success' ? 0 : 1);
  }

  await new Promise(resolve => setTimeout(resolve, pollSeconds * 1000));
}
