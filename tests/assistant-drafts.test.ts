import { describe, expect, it, vi } from 'vitest';
import { handleAssistant, parseAssistantCommand } from '../supabase/functions/assistant/handler';
import type { ClaudeClient } from '../supabase/functions/_shared/claude';

const TEAM = '64200000-0000-4000-8000-0000000000a1';
const USER = '64200000-0000-4000-8000-000000000001';
const OFFER = '64200000-0000-4000-8000-0000000000f1';
const AGENT = '64200000-0000-4000-8000-0000000000e2';
const M16 = '64200000-0000-4000-8000-000000000016';
const M18 = '64200000-0000-4000-8000-000000000018';
const now = () => new Date('2026-11-21T10:00:00Z');

const plan = (overrides: Record<string, unknown> = {}) => ({
  reply: 'Готую 5 запусків ProCaps на G2.',
  actions: [
    {
      type: 'create_drafts',
      offer: 'ProCaps',
      accounts: ['G2'],
      count: 5,
      dates: { kind: 'today', date: null, days: null },
      base: 'offer_defaults',
      baseRow: null,
      rows: [],
      fields: [
        { field: 'creatives', op: 'set', value: ['TR 16'] },
        { field: 'campaignCount', op: 'set', value: 2 },
        { field: 'catalog.productCount', op: 'set', value: 100 },
        { field: 'originalUrl', op: 'set', value: '⟦url:1⟧' }
      ],
      overrides: [],
      question: null,
      ...overrides
    }
  ]
});

function model(answer: unknown): ClaudeClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    create: vi.fn(async request => {
      calls.push(request.user);
      return {
        stopReason: 'end_turn',
        text: JSON.stringify(answer),
        usage: { input: 3000, output: 400, cacheRead: 0, cacheWrite: 0 }
      };
    })
  } as ClaudeClient & { calls: string[] };
}

function world(
  options: { materials?: Array<{ id: string; name: string }>; replay?: boolean } = {}
) {
  const saved: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const stored = new Map<string, unknown>();
  let commands = 0;
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push(name);
    switch (name) {
      case 'service_assistant_context':
      case 'service_assistant_context_v2':
        return {
          data: { conversationId: 'conv', canSaveDefaults: true, priceVersion: 'v1' },
          error: null
        };
      case 'service_assistant_begin':
      case 'service_assistant_begin_v2':
        commands++;
        return options.replay
          ? {
              data: {
                commandId: '64200000-0000-4000-8000-0000000000c0',
                replayed: true,
                reply: { id: 9 }
              },
              error: null
            }
          : {
              data: {
                commandId: `64200000-0000-4000-8000-0000000000c${commands}`,
                replayed: false
              },
              error: null
            };
      case 'service_ai_credit_debit':
        return { data: { replayed: false, credits: {} }, error: null };
      case 'service_assistant_status':
        if (args.p_plan) stored.set(args.p_command as string, args.p_plan);
        return { data: null, error: null };
      case 'service_assistant_card_state':
        return { data: true, error: null };
      case 'service_assistant_put_urls':
        stored.set(`urls:${args.p_command}`, args.p_urls);
        return { data: null, error: null };
      case 'service_assistant_urls':
        return { data: stored.get(`urls:${args.p_command}`) ?? [], error: null };
      case 'service_assistant_command':
        return { data: { plan: stored.get(args.p_command as string) ?? null }, error: null };
      case 'list_launch_dictionaries':
        return {
          data: { offers: [{ id: OFFER, value: 'ProCaps', updatedAt: 'x' }], buyers: [] },
          error: null
        };
      case 'list_team_accounts':
        return { data: [{ id: 'acc', agents: [{ id: AGENT, agent_id: 'G2' }] }], error: null };
      case 'search_materials':
        return {
          data: {
            items: (
              options.materials ?? [
                { id: M16, name: 'TR_16.mp4' },
                { id: M18, name: 'TR_18.mp4' }
              ]
            ).map(m => ({
              ...m,
              mimeType: 'video/mp4'
            }))
          },
          error: null
        };
      case 'get_launch_offer_defaults':
        return {
          data: {
            config: {
              maxBudget: 40,
              minBudget: 10,
              budgetMode: 'auto',
              catalog: {
                productCount: 60,
                restitchEnabled: false,
                finalDurationMode: 'random-30-40',
                customFinalDurationSeconds: null
              }
            },
            subConfig: { schemaVersion: 1, sub1: ['buyer'], sub2: [], sub3: [] },
            version: '3'
          },
          error: null
        };
      case 'save_launch_draft':
        saved.push(args.p_config as Record<string, unknown>);
        return {
          data: { id: `64200000-0000-4000-8000-00000000d00${saved.length}`, version: '1' },
          error: null
        };
      case 'service_assistant_rows':
        return {
          data: ((args.p_ids as string[] | null) ?? []).map((id, index) => ({
            id,
            version: '1',
            config: saved[index] ?? {},
            account: 'G2',
            offer: 'ProCaps',
            materials: [{ id: M16, name: 'TR_16.mp4' }]
          })),
          error: null
        };
      case 'service_assistant_reply':
        return {
          data: { id: 1, role: 'assistant', text: args.p_text, cards: args.p_cards },
          error: null
        };
      default:
        return { data: null, error: null };
    }
  });
  return { rpc, saved, calls };
}

const send = (text: string, extra: Record<string, unknown> = {}) =>
  parseAssistantCommand({
    action: 'send',
    teamId: TEAM,
    text,
    clientKey: 'client-key-0001',
    expectedPrice: 1,
    priceVersion: 'v1',
    contextCardId: null,
    timezone: 'Europe/Kyiv',
    ...extra
  });

const MESSAGE =
  'На сьогодні 5 запусків ProCaps на G2. Туреччина, відео TR 16, по 2 кампанії, по 100 товарів, ось посилання https://shop.example/p?x=1';

describe('064 assistant: one message makes ordinary drafts', () => {
  it('creates exactly five drafts with explicit and inherited values and starts nothing', async () => {
    const { rpc, saved, calls } = world();
    const client = model(plan());
    const result = await handleAssistant(send(MESSAGE), {
      userId: USER,
      callerRpc: rpc,
      serviceRpc: rpc,
      client,
      now
    });
    expect(saved).toHaveLength(5);
    for (const config of saved) {
      expect(config).toMatchObject({
        offerId: OFFER,
        agentRowId: AGENT,
        campaignCount: 2,
        maxBudget: 40,
        originalUrl: 'https://shop.example/p?x=1',
        launchDate: '2026-11-21',
        catalog: { productCount: 100 }
      });
      expect((config.creatives as Array<{ materialId: string }>)[0]!.materialId).toBe(M16);
    }
    // one model call, the link never reached it, one debit of the shown price
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toContain('⟦url:1⟧');
    expect(client.calls[0]).not.toContain('shop.example');
    expect(calls.filter(name => name === 'service_ai_credit_debit')).toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith(
      'service_ai_credit_debit',
      expect.objectContaining({ p_amount: 1 })
    );
    expect(calls).not.toContain('service_accept_launch_batch');
    const cards = (
      result.message as { cards: Array<{ kind: string; payload: { rows: unknown[] } }> }
    ).cards;
    expect(cards[0]!.kind).toBe('result');
    expect(cards[0]!.payload.rows).toHaveLength(5);
  });

  it('replays a repeated delivery without a model call or another draft', async () => {
    const { rpc, saved, calls } = world({ replay: true });
    const client = model(plan());
    const result = await handleAssistant(send(MESSAGE), {
      userId: USER,
      callerRpc: rpc,
      serviceRpc: rpc,
      client,
      now
    });
    expect(result.replayed).toBe(true);
    expect(client.calls).toHaveLength(0);
    expect(saved).toHaveLength(0);
    expect(calls).not.toContain('service_ai_credit_debit');
  });

  it('answers «запускай» with a review card, free and without a model', async () => {
    const { rpc, calls } = world();
    const client = model(plan());
    const result = await handleAssistant(send('запускай', { expectedPrice: 0 }), {
      userId: USER,
      callerRpc: rpc,
      serviceRpc: rpc,
      client,
      now
    });
    expect(client.calls).toHaveLength(0);
    expect(calls).not.toContain('service_ai_credit_debit');
    expect((result.message as { cards: Array<{ kind: string }> }).cards[0]!.kind).toBe('review');
  });

  it('refuses a label priced differently before anything is charged', async () => {
    const { rpc, calls } = world();
    await expect(
      handleAssistant(send(MESSAGE, { expectedPrice: 2 }), {
        userId: USER,
        callerRpc: rpc,
        serviceRpc: rpc,
        client: model(plan()),
        now
      })
    ).rejects.toMatchObject({ code: 'PRICE_CHANGED' });
    expect(calls).toHaveLength(0);
  });

  it('gives the credits back when the model answer is not a valid plan', async () => {
    const { rpc, saved, calls } = world();
    const client = model({ reply: 'x', actions: [{ type: 'start_generation' }] });
    const result = await handleAssistant(send(MESSAGE), {
      userId: USER,
      callerRpc: rpc,
      serviceRpc: rpc,
      client,
      now
    });
    expect(saved).toHaveLength(0);
    expect(calls).toContain('service_ai_credit_refund');
    expect(
      (result.message as { cards: Array<{ payload: { code: string } }> }).cards[0]!.payload.code
    ).toBe('MODEL_OUTPUT_REJECTED');
  });

  it('asks which material when two match, writes nothing, and continues on the button without a model', async () => {
    const twins = [
      { id: M16, name: 'TR_16.mp4' },
      { id: M18, name: 'TR-16.mp4' }
    ];
    const { rpc, saved } = world({ materials: twins });
    const client = model(plan());
    const asked = await handleAssistant(send(MESSAGE), {
      userId: USER,
      callerRpc: rpc,
      serviceRpc: rpc,
      client,
      now
    });
    const question = (
      asked.message as { cards: Array<{ kind: string; payload: Record<string, unknown> }> }
    ).cards[0]!;
    expect(question.kind).toBe('question');
    expect(saved).toHaveLength(0);

    // The button: the server reads the card, then continues the stored plan with the choice.
    rpc.mockImplementationOnce(async () => ({
      data: { id: 'card', kind: 'question', commandId: null, payload: question.payload },
      error: null
    }));
    const answered = await handleAssistant(
      parseAssistantCommand({
        action: 'answer',
        teamId: TEAM,
        cardId: '64200000-0000-4000-8000-0000000000aa',
        optionId: M18,
        clientKey: 'client-key-0002',
        timezone: 'Europe/Kyiv'
      }),
      { userId: USER, callerRpc: rpc, serviceRpc: rpc, client, now }
    );
    expect(client.calls).toHaveLength(1);
    expect(saved).toHaveLength(5);
    expect((saved[0]!.creatives as Array<{ materialId: string }>)[0]!.materialId).toBe(M18);
    expect((answered.message as { cards: Array<{ kind: string }> }).cards[0]!.kind).toBe('result');
  });

  it('rejects requests with unknown keys or a malformed card id', () => {
    expect(() => send(MESSAGE, { launch: true })).toThrow();
    expect(() => send(MESSAGE, { contextCardId: 'not-a-uuid' })).toThrow();
    expect(() => send('я'.repeat(4001))).toThrow();
  });
});
