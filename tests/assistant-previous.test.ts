import { describe, expect, it } from 'vitest';
import { parseAssistantCommand } from '../supabase/functions/assistant/handler';
import {
  assistantSystemPrompt,
  assistantUserPrompt
} from '../supabase/functions/assistant/interpret';

/**
 * 064: «а тепер те саме за вчора» — found on next 2026-11-22: the model did not see the dialog's
 * previous request and asked what «те саме» was. The window now names the previous command; the
 * server reads its plan and puts it beside the message.
 */
const TEAM = '00000000-0000-4000-8000-000000000001';
const PREVIOUS = '00000000-0000-4000-8000-0000000000c1';

describe('the previous request of a dialog', () => {
  it('is accepted with a message, and nothing else is', () => {
    const command = parseAssistantCommand({
      action: 'send',
      teamId: TEAM,
      text: 'а тепер те саме за вчора',
      clientKey: 'key-00000001',
      expectedPrice: 1,
      priceVersion: 'v1',
      contextCardId: null,
      previousCommandId: PREVIOUS,
      timezone: 'Europe/Kyiv'
    });
    expect(command).toMatchObject({ action: 'send', previousCommandIds: [PREVIOUS] });
    expect(
      parseAssistantCommand({
        action: 'send',
        teamId: TEAM,
        text: 'як два запити тому',
        clientKey: 'key-00000001',
        expectedPrice: 1,
        priceVersion: 'v1',
        contextCardId: null,
        previousCommandIds: [PREVIOUS, TEAM, PREVIOUS],
        timezone: 'Europe/Kyiv'
      })
    ).toMatchObject({ previousCommandIds: [PREVIOUS, TEAM] });
    expect(() =>
      parseAssistantCommand({
        action: 'send',
        teamId: TEAM,
        text: 'x',
        clientKey: 'key-00000001',
        expectedPrice: 1,
        priceVersion: 'v1',
        previousCommandId: 'not-a-uuid',
        timezone: 'Europe/Kyiv'
      })
    ).toThrow();
  });

  it('names up to three, newest first', () => {
    const prompt = assistantUserPrompt({
      today: '2026-11-22',
      timezone: 'Europe/Kyiv',
      offers: [],
      buyers: [],
      accounts: [],
      shownRows: [],
      lastOffer: null,
      previous: ['use_tool finance_report(by=tag)', 'use_tool finance_report(by=account)'],
      message: 'як два запити тому'
    });
    expect(prompt).toContain('1. use_tool finance_report(by=tag)');
    expect(prompt).toContain('2. use_tool finance_report(by=account)');
  });

  it('reaches the model beside the message, with the rule to repeat it with the change', () => {
    const prompt = assistantUserPrompt({
      today: '2026-11-22',
      timezone: 'Europe/Kyiv',
      offers: [],
      buyers: [],
      accounts: [],
      shownRows: [],
      lastOffer: null,
      previous: 'use_tool finance_report(date=2026-11-20, by=account)',
      message: 'а тепер те саме за вчора'
    });
    expect(prompt).toContain(
      'Previous request of this dialog: use_tool finance_report(date=2026-11-20, by=account)'
    );
    expect(assistantSystemPrompt()).toMatch(/«те саме».*previous request/u);
  });
});
