/**
 * 064 FR-036: choose the assistant's model on the synthetic corpus, with the exact prompt and
 * schema the edge function uses.
 *
 *   npx tsx scripts/acceptance/assistant-model-benchmark.ts            # dry run on a fake model
 *   ANTHROPIC_API_KEY=… npx tsx scripts/acceptance/assistant-model-benchmark.ts --paid [--cap 3]
 *
 * A control command passes when its plan is right in at least 2 of 3 repeats; a class passes at
 * ≥ 95 % of its commands, ≤ 10 % unstable and ≤ 5 % needless questions; any action outside the
 * schema reaching a write fails the model outright. Haiku runs first; Sonnet only when no Haiku
 * configuration passes. Writes aggregates only to specs/064-text-launch-control/model-results.md.
 */
import { writeFileSync } from 'node:fs';
import {
  parseAssistantPlan,
  type AssistantPlan
} from '../../packages/shared/dist/team/assistant.js';
import {
  assistantUserPrompt,
  assistantSystemPrompt
} from '../../supabase/functions/assistant/interpret.ts';
import { assistantPlanSchema } from '../../packages/shared/dist/team/assistant.js';
import {
  callStructured,
  costMicroUsd,
  type ClaudeClient,
  type ClaudeEffort,
  type ClaudeModel
} from '../../supabase/functions/_shared/claude.ts';
import {
  benchmarkCorpus,
  BENCH_CONTEXT,
  type BenchCase
} from '../../tests/fixtures/assistant/uk-commands.ts';

const args = process.argv.slice(2);
const paid = args.includes('--paid');
const capUsd = Number(args[args.indexOf('--cap') + 1]) || (paid ? 3 : Infinity);
const REPEATS = 3;
const CONFIGS: Array<{ model: ClaudeModel; effort: ClaudeEffort }> = [
  { model: 'claude-haiku-5-5', effort: 'low' },
  { model: 'claude-haiku-5-5', effort: 'medium' },
  { model: 'claude-sonnet-5-5', effort: 'low' }
];

function fetchClient(apiKey: string): ClaudeClient {
  return {
    async create(request, signal) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
          output_config: {
            effort: request.effort,
            format: { type: 'json_schema', schema: request.schema }
          }
        })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const message = (await response.json()) as {
        stop_reason: string | null;
        content: Array<{ type: string; text?: string }>;
        usage: Record<string, number | undefined>;
      };
      return {
        stopReason: message.stop_reason,
        text:
          message.content
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('') || null,
        usage: {
          input: message.usage.input_tokens ?? 0,
          output: message.usage.output_tokens ?? 0,
          cacheRead: message.usage.cache_read_input_tokens ?? 0,
          cacheWrite: message.usage.cache_creation_input_tokens ?? 0
        }
      };
    }
  };
}

/** A deterministic stand-in that answers from the expectation, wrong on purpose every 25th call. */
function fakeClient(cases: Map<string, BenchCase>): ClaudeClient {
  let n = 0;
  return {
    async create(request) {
      n++;
      const message = /<<<\n([\s\S]*)\n>>>/u.exec(request.user)?.[1] ?? '';
      const item = [...cases.values()].find(
        c => c.text.replace(/https?:\/\/\S+/gu, '⟦url:1⟧') === message
      );
      const types = n % 25 === 0 ? ['out_of_scope'] : (item?.expect.types ?? ['out_of_scope']);
      const plan = {
        reply: 'ok',
        actions: types.map(type => ({
          type,
          offer: null,
          accounts: item?.expect.accounts ?? [],
          count: item?.expect.count ?? null,
          dates: item?.expect.days
            ? { kind: 'each_day', date: null, days: item.expect.days }
            : null,
          base: null,
          baseRow: null,
          rows: item?.expect.rows ?? [],
          fields: Object.entries(item?.expect.fields ?? {}).map(([field, value]) => ({
            field,
            op: 'set',
            value
          })),
          overrides: [],
          question:
            type === 'ask' ? { about: 'TR_16 чи 16 відео?', options: ['TR_16', '16 різних'] } : null
        }))
      };
      return {
        stopReason: 'end_turn',
        text: JSON.stringify(plan),
        usage: { input: 3000, output: 300, cacheRead: 0, cacheWrite: 0 }
      };
    }
  };
}

type Verdict = 'right' | 'ask' | 'wrong' | 'forbidden' | 'invalid';

function judge(item: BenchCase, plan: AssistantPlan | null): Verdict {
  if (!plan) return 'invalid';
  const types = plan.actions.map(action => action.type);
  if ((item.expect.forbidden ?? []).some(type => types.includes(type as never))) return 'forbidden';
  if (types.length === 1 && types[0] === 'ask') return item.expect.askOk ? 'right' : 'ask';
  if (JSON.stringify(types) !== JSON.stringify(item.expect.types)) return 'wrong';
  const first =
    plan.actions.find(action => action.type === item.expect.types[item.expect.types.length - 1]) ??
    plan.actions[0]!;
  if (item.expect.count !== undefined && first.count !== item.expect.count) return 'wrong';
  if (
    item.expect.accounts &&
    JSON.stringify(first.accounts) !== JSON.stringify(item.expect.accounts)
  )
    return 'wrong';
  if (item.expect.rows && JSON.stringify(first.rows) !== JSON.stringify(item.expect.rows))
    return 'wrong';
  if (item.expect.days !== undefined && first.dates?.days !== item.expect.days) return 'wrong';
  for (const [path, value] of Object.entries(item.expect.fields ?? {})) {
    const change = plan.actions
      .flatMap(action => action.fields)
      .find(change => change.field === path);
    if (!change || JSON.stringify(change.value) !== JSON.stringify(value)) return 'wrong';
  }
  return 'right';
}

async function run() {
  const corpus = benchmarkCorpus();
  const control = corpus.filter(item => item.set === 'control');
  const byId = new Map(corpus.map(item => [item.id, item]));
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (paid && !apiKey) throw new Error('ANTHROPIC_API_KEY is required for --paid');
  const client = paid ? fetchClient(apiKey) : fakeClient(byId);
  const lines: string[] = [];
  let spentMicro = 0;
  let passed: string | null = null;
  for (const config of CONFIGS) {
    if (passed && config.model === 'claude-sonnet-5-5') break;
    const results = new Map<string, Verdict[]>();
    let micro = 0;
    let calls = 0;
    for (const item of control) {
      const verdicts: Verdict[] = [];
      for (let repeat = 0; repeat < REPEATS; repeat++) {
        if (spentMicro / 1e6 >= capUsd) throw new Error(`Spending cap $${capUsd} reached`);
        const outcome = await callStructured(
          client,
          {
            model: config.model,
            effort: config.effort,
            system: assistantSystemPrompt(),
            user: assistantUserPrompt({
              today: '2026-11-21',
              timezone: 'Europe/Kyiv',
              offers: BENCH_CONTEXT.offers,
              buyers: BENCH_CONTEXT.buyers,
              accounts: BENCH_CONTEXT.accounts,
              shownRows: item.shownRows,
              lastOffer: null,
              message: item.text.replace(/https?:\/\/\S+/gu, '⟦url:1⟧')
            }),
            schema: assistantPlanSchema(),
            maxTokens: 2048
          },
          { signal: AbortSignal.timeout(60_000), record: () => {} }
        );
        calls++;
        micro += costMicroUsd(config.model, outcome.usage);
        spentMicro += costMicroUsd(config.model, outcome.usage);
        verdicts.push(outcome.ok ? judge(item, parseAssistantPlan(outcome.value)) : 'invalid');
      }
      results.set(item.id, verdicts);
    }
    const classes = [...new Set(control.map(item => item.cls))];
    let configPasses = true;
    const rows: string[] = [];
    let forbidden = 0;
    for (const cls of classes) {
      const items = control.filter(item => item.cls === cls);
      const counted = items.filter(
        item => results.get(item.id)!.filter(v => v === 'right').length >= 2
      ).length;
      const unstable = items.filter(item => new Set(results.get(item.id)).size > 1).length;
      const asks = items.filter(item => results.get(item.id)!.includes('ask')).length;
      forbidden += items.filter(item => results.get(item.id)!.includes('forbidden')).length;
      const ok =
        counted / items.length >= 0.95 &&
        unstable / items.length <= 0.1 &&
        asks / items.length <= 0.05;
      if (!ok) configPasses = false;
      rows.push(
        `| ${cls} | ${counted}/${items.length} | ${unstable} | ${asks} | ${ok ? 'так' : 'ні'} |`
      );
    }
    if (forbidden > 0) configPasses = false;
    const per100 = (micro / 1e6 / calls) * 100;
    lines.push(
      `### ${config.model} · effort ${config.effort} — ${configPasses ? 'пройшла' : 'не пройшла'}`,
      '',
      `Викликів: ${calls}. Вартість прогону: $${(micro / 1e6).toFixed(4)}. На 100 реплік: $${per100.toFixed(4)}. Недозволених дій: ${forbidden}.`,
      '',
      '| Клас | Зараховано | Нестабільних | Зайвих питань | Пройшов |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
      ''
    );
    if (configPasses && !passed) passed = `${config.model} · ${config.effort}`;
  }
  const report = [
    '# 064 · Вибір моделі помічника',
    '',
    `Режим: ${paid ? 'платний прогін' : 'підміна (перевірка обв’язки, не результат вибору)'} · ${new Date().toISOString()}`,
    `Корпус: ${control.length} контрольних команд, ${REPEATS} повтори. Ціни — з \`supabase/functions/_shared/claude.ts\`.`,
    '',
    `Обрано: ${passed ?? 'жодна конфігурація не пройшла'}.`,
    '',
    ...lines
  ].join('\n');
  const target = paid
    ? 'specs/064-text-launch-control/model-results.md'
    : 'specs/064-text-launch-control/model-results.dry-run.md';
  writeFileSync(target, report + '\n');
  process.stdout.write(`${report}\n\nwritten: ${target}\n`);
}

run().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
