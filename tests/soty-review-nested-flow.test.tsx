// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TeamSettingsReview } from '../apps/soty-review/src/screens/team/TeamSettingsReview.js';
import { reviewCatalog } from '../apps/soty-review/src/review/catalog.js';

describe('Soty nested and confirmation flow', () => {
  it('shows context, back path, target and consequence', () => {
    const dispatch = vi.fn();
    const model = reviewCatalog.surfaces.find(item => item.id === 'team-settings')!.states[0].model;
    render(<TeamSettingsReview model={model} referencePrefix="test" dispatch={dispatch} />);
    expect(screen.getByText(/Soty \/ Налаштування/)).toBeTruthy();
    expect(screen.getByText(/Ціль:/)).toBeTruthy();
    expect(screen.getByText(/Наслідок:/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Назад/ }));
    expect(dispatch).toHaveBeenCalledWith({ type: 'advance-demo' });
  });
});
