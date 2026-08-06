// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HomeReview } from '../apps/soty-review/src/screens/home/HomeReview.js';
import { SotyMotifs } from '../apps/soty-review/src/components/SotyMotifs.js';
import { reviewCatalog } from '../apps/soty-review/src/review/catalog.js';

describe('Soty primary actions', () => {
  it('uses one honey CTA per tool card and card/CTA share the same action', () => {
    const dispatch = vi.fn();
    const model = reviewCatalog.surfaces.find(item => item.id === 'home-tools')!.states[0].model;
    render(<HomeReview model={model} referencePrefix="test/home/default" dispatch={dispatch} />);
    const card = screen.getByText('Командний простір').closest('.soty-card')!;
    fireEvent.click(card);
    fireEvent.click(screen.getAllByRole('button', { name: 'Відкрити' })[0]);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(card.querySelectorAll('.soty-action-primary')).toHaveLength(1);
  });

  it('keeps motifs decorative', () => {
    const { container } = render(<SotyMotifs />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('button,a,[tabindex]')).toHaveLength(0);
  });
});
