// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantCard } from '@video-compressor/shared';
import { TableCard, ToolReviewCard } from '../apps/web/src/team/assistant/ToolCards';

/**
 * 064: what the space tools' cards say — found on next 2026-11-22: the untagged group read «—»,
 * sums had no thousands separator, and a rename row named the file twice.
 */
afterEach(cleanup);

const card = (kind: AssistantCard['kind'], payload: Record<string, unknown>): AssistantCard => ({
  id: 'c1',
  kind,
  state: 'open',
  commandId: null,
  payload,
  createdAt: '2026-11-22T10:00:00Z'
});

describe('the space tools’ cards', () => {
  it('names the untagged group and formats money in the copied text too', () => {
    render(
      <TableCard
        card={card('table', {
          tool: 'topup_statement',
          from: '2026-11-16',
          to: '2026-11-22',
          columns: ['group', 'count', 'topup'],
          rows: [
            ['#2', '7', '2800.00'],
            ['{untagged}', '11', '4300.00']
          ],
          total: ['18', '7100.00'],
          copyText: '{untagged} — $4300',
          missing: []
        })}
      />
    );
    expect(screen.queryByText('{untagged}')).toBeNull();
    expect(screen.getByText(/2[\s,.  ]?800/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Копіювати|Copy/u })).toBeTruthy();
  });

  it('shows a rename as old → new without naming the file twice', () => {
    render(
      <ToolReviewCard
        card={card('review', {
          purpose: 'tool',
          tool: 'rename_materials',
          items: [{ label: 'qa-a', from: 'qa-a', to: 'qa-alpha' }]
        })}
        pending={false}
        disabled={false}
        onRun={vi.fn()}
      />
    );
    expect(screen.getAllByText(/qa-a/u)).toHaveLength(1);
    expect(screen.getByText('qa-a → qa-alpha')).toBeTruthy();
  });

  it('says where new folders go, that a tag is new, and that folders are not moved', () => {
    render(
      <>
        <ToolReviewCard
          card={card('review', {
            purpose: 'tool',
            tool: 'create_folders',
            parent: { id: 'f', label: 'Soty QA tools' },
            items: [{ label: 'qa-a', name: 'qa-a', exists: false }]
          })}
          pending={false}
          disabled={false}
          onRun={vi.fn()}
        />
        <ToolReviewCard
          card={card('review', {
            purpose: 'tool',
            tool: 'tag_ad_accounts',
            created: ['#qa'],
            items: [{ label: 'qa-tools-334', from: null, to: '#qa' }]
          })}
          pending={false}
          disabled={false}
          onRun={vi.fn()}
        />
        <ToolReviewCard
          card={card('review', {
            purpose: 'tool',
            tool: 'move_materials',
            destination: { label: 'TR' },
            folders: ['old'],
            items: [{ label: 'TR_16.mp4', id: 'm16' }]
          })}
          pending={false}
          disabled={false}
          onRun={vi.fn()}
        />
      </>
    );
    expect(screen.getByText(/Soty QA tools/u)).toBeTruthy();
    expect(screen.getByText(/#qa\./u)).toBeTruthy();
    expect(screen.getByText(/old$/u)).toBeTruthy();
  });

  it('makes a removal red and says where things go', () => {
    const { container } = render(
      <ToolReviewCard
        card={card('review', {
          purpose: 'tool',
          tool: 'trash_catalogs',
          danger: true,
          items: [{ label: 'TR_16_catalog', id: 'c1' }]
        })}
        pending={false}
        disabled={false}
        onRun={vi.fn()}
      />
    );
    expect(container.querySelector('.assistant-card.is-danger')).not.toBeNull();
    expect(screen.getByText(/Google Drive/u)).toBeTruthy();
  });
});
