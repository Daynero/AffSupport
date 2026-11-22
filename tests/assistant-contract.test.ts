import { describe, expect, it } from 'vitest';
import {
  assistantKey,
  assistantNumber,
  assistantPlanSchema,
  assistantUrlSlot,
  extractAssistantUrls,
  matchAssistantName,
  parseAssistantMessage,
  parseAssistantPlan,
  quickAssistantIntent
} from '@video-compressor/shared';

const action = {
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
  question: null
};

describe('064 assistant contract', () => {
  it('accepts a well-formed plan and nothing else', () => {
    const plan = parseAssistantPlan({ reply: 'Готую 5 запусків.', actions: [action] });
    expect(plan?.actions[0]).toMatchObject({ type: 'create_drafts', count: 5, accounts: ['G2'] });
    // an extra field anywhere rejects the whole plan
    expect(parseAssistantPlan({ reply: 'x', actions: [{ ...action, launch: true }] })).toBeNull();
    expect(parseAssistantPlan({ reply: 'x', actions: [action], extra: 1 })).toBeNull();
    // an action outside the closed list
    expect(
      parseAssistantPlan({ reply: 'x', actions: [{ ...action, type: 'start_generation' }] })
    ).toBeNull();
    // a field change with an unknown op or a nested object value
    expect(
      parseAssistantPlan({
        reply: 'x',
        actions: [{ ...action, fields: [{ field: 'campaignCount', op: 'run', value: 1 }] }]
      })
    ).toBeNull();
    expect(
      parseAssistantPlan({
        reply: 'x',
        actions: [{ ...action, fields: [{ field: 'a', op: 'set', value: { url: 'x' } }] }]
      })
    ).toBeNull();
    // ask without a question is dropped, an overlong one is cut, never the whole plan
    expect(
      parseAssistantPlan({ reply: 'x', actions: [{ ...action, type: 'ask' }, action] })?.actions
    ).toHaveLength(1);
    const many = parseAssistantPlan({
      reply: 'x',
      actions: [
        {
          ...action,
          type: 'ask',
          question: { about: 'Який баєр?', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }
        }
      ]
    });
    expect(many?.actions[0]?.question?.options).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(parseAssistantPlan({ reply: 'x', actions: Array(17).fill(action) })).toBeNull();
  });

  it('offers the model only fields the assistant may change and no way to start generation', () => {
    const schema = JSON.stringify(assistantPlanSchema());
    expect(schema).toContain('catalog.copyVideoToR2');
    expect(schema).not.toContain('"notes"');
    expect(schema).not.toMatch(/launch_generation|start|confirm/u);
  });

  it('handles short replies without a model, and «запускай» only shows the review', () => {
    expect(quickAssistantIntent('запускай')).toBe('review');
    expect(quickAssistantIntent('Запусти всі на сьогодні')).toBe('review_today');
    expect(quickAssistantIntent('скасуй')).toBe('undo');
    expect(quickAssistantIntent('так')).toBe('yes');
    expect(quickAssistantIntent('запускай 5 запусків на G2')).toBeNull();
  });

  it('normalises names across scripts and dictation', () => {
    expect(assistantKey('ProCaps')).toBe(assistantKey('прокапс'));
    expect(assistantKey('Г2')).toBe(assistantKey('G2'));
    expect(assistantNumber('шістнадцяте')).toBe(16);
    expect(assistantNumber('друга')).toBe(2);
    expect(assistantNumber('TR 18')).toBe(18);
  });

  it('matches materials by alias number and returns ambiguity instead of guessing', () => {
    const materials = [
      { id: 'a', name: 'TR_16.mp4' },
      { id: 'b', name: 'TR_18.mp4' },
      { id: 'c', name: 'DE_16.mp4' }
    ];
    expect(matchAssistantName('TR 16', materials)).toEqual({
      kind: 'one',
      candidate: materials[0]
    });
    expect(matchAssistantName('tr16', materials)).toEqual({ kind: 'one', candidate: materials[0] });
    expect(matchAssistantName('шістнадцяте', materials)).toMatchObject({ kind: 'many' });
    expect(matchAssistantName('TR 25', materials)).toEqual({ kind: 'none' });
    expect(matchAssistantName('прокапс', [{ id: 'o', name: 'ProCaps' }])).toMatchObject({
      kind: 'one'
    });
    // names written by ear find their offer; numbers never go fuzzy
    const offers = [
      { id: 'p', name: 'Proveliq TR' },
      { id: 's', name: 'Prostavia ID' },
      { id: 'm', name: 'Multixan SA' }
    ];
    expect(matchAssistantName('провелік тр', offers)).toEqual({
      kind: 'one',
      candidate: offers[0]
    });
    expect(matchAssistantName('простовія', offers)).toEqual({ kind: 'one', candidate: offers[1] });
    expect(matchAssistantName('мультіксан', offers)).toEqual({ kind: 'one', candidate: offers[2] });
    expect(matchAssistantName('Flexi TR', offers)).toEqual({ kind: 'none' });
    expect(matchAssistantName('TR 17', materials)).toEqual({ kind: 'none' });
  });

  it('keeps pasted links out of the model text and puts them back only by marker', () => {
    const { text, urls } = extractAssistantUrls(
      'ось посилання https://ex.com/a?b=1, і ще https://ex.com/a?b=1.'
    );
    expect(text).toBe('ось посилання ⟦url:1⟧, і ще ⟦url:1⟧.');
    expect(urls).toEqual(['https://ex.com/a?b=1']);
    expect(assistantUrlSlot('⟦url:1⟧', urls)).toBe('https://ex.com/a?b=1');
    expect(assistantUrlSlot('https://evil.example', urls)).toBeNull();
    expect(assistantUrlSlot('⟦url:2⟧', urls)).toBeNull();
  });

  it('reads server messages and rejects unknown card kinds', () => {
    const message = {
      id: 1,
      role: 'assistant',
      text: 'Готово',
      price: 0,
      commandId: null,
      createdAt: '2026-11-21T10:00:00Z',
      cards: [
        { id: 'c', kind: 'review', state: 'open', commandId: null, payload: {}, createdAt: 'x' }
      ]
    };
    expect(parseAssistantMessage(message)?.cards[0]?.kind).toBe('review');
    expect(
      parseAssistantMessage({ ...message, cards: [{ ...message.cards[0], kind: 'html' }] })
    ).toBeNull();
  });
});
