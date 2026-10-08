import { describe, expect, it } from 'vitest';
import { freezeProgress, projectProgress } from '../scripts/lib/release/progress.mjs';
import { STEP_IDS } from '../scripts/lib/release/steps.mjs';
import { releaseMetrics } from '../scripts/lib/release/metrics.mjs';
import { JournalObserver } from '../scripts/lib/release/observation.mjs';
import { createJournal } from '../scripts/lib/release/journal.mjs';
import { mkdtemp, appendFile, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
describe('truthful release observations', () => {
  it('keeps the panel separate from the production build entry', async () => {
    const panel = await readFile(path.resolve('apps/web/vite.release-panel.config.ts'), 'utf8');
    const production = await readFile(path.resolve('apps/web/vite.config.ts'), 'utf8');
    expect(panel).toContain('release-panel.html');
    expect(panel).toContain('release/automation/panel');
    expect(production).not.toContain('release-panel');
    const html = await readFile(path.resolve('apps/web/release-panel.html'), 'utf8');
    expect(html).toContain('/src/release-panel/main.tsx');
    expect(html).not.toContain('/src/main.tsx');
  });
  it('incrementally verifies UTF-8 and quarantines incomplete observations', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'panel-observe-'));
    const runId = randomUUID();
    const journal = await createJournal(root, runId);
    await journal.append('step_completed', { stepId: 'prepare', text: 'і'.repeat(40000) });
    const observer = new JournalObserver(journal.journalPath, runId);
    expect(await observer.read()).toHaveLength(1);
    const offset = observer.offset;
    expect(await observer.read()).toHaveLength(1);
    expect(observer.offset).toBe(offset);
    await appendFile(journal.journalPath, '{');
    expect(await observer.read()).toHaveLength(1);
    await appendFile(journal.journalPath, 'broken}\n');
    await expect(observer.read()).rejects.toThrow();
  });
  it('rejects a corrupted hash chain instead of showing false progress', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'panel-corrupt-'));
    const runId = randomUUID();
    const journal = await createJournal(root, runId);
    await journal.append('step_completed', { stepId: 'prepare' });
    const raw = await readFile(journal.journalPath, 'utf8');
    await writeFile(journal.journalPath, raw.replace('prepare', 'publish'));
    await expect(new JournalObserver(journal.journalPath, runId).read()).rejects.toThrow(
      'JOURNAL_CORRUPT'
    );
  });
  it('never invents progress from heartbeat or a completion claim', () => {
    const plan = freezeProgress();
    expect(projectProgress(plan, { state: 'completed' }, []).percent).toBe(0);
    const events = STEP_IDS.map(stepId => ({ type: 'step_completed', payload: { stepId } }));
    expect(projectProgress(plan, { state: 'completed' }, events).percent).toBe(99);
    events.push({ type: 'run_completed', payload: { stepId: 'live_verify' } });
    expect(projectProgress(plan, { state: 'completed' }, events).percent).toBe(100);
  });
  it('uses canonical payloads and deduplicates cumulative model usage', () => {
    expect(
      releaseMetrics([
        { type: 'step_completed', payload: { stepId: 'prepare', durationMs: 2 } },
        { type: 'model_usage', payload: { executionId: 'a', tokens: 10 } },
        { type: 'model_usage', payload: { executionId: 'a', tokens: 12 } }
      ])
    ).toMatchObject({ timings: { prepare: 2 }, modelTokens: 12 });
    expect(releaseMetrics([]).modelTokens).toBeNull();
  });
});
