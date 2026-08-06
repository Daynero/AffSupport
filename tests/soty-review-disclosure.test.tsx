// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CompressorReview } from '../apps/soty-review/src/screens/compressor/CompressorReview.js';
import { reviewCatalog } from '../apps/soty-review/src/review/catalog.js';

describe('Soty progressive disclosure', () => {
  it('keeps defaults and consequence visible before advanced settings', () => {
    const dispatch = vi.fn();
    const model = reviewCatalog.surfaces.find(item => item.id === 'compressor')!.states[0].model;
    render(<CompressorReview model={model} referencePrefix="test" dispatch={dispatch} />);
    expect(screen.getByText(/Оптимальний/)).toBeTruthy();
    expect(screen.getByText(/Наслідок/)).toBeTruthy();
    expect(screen.queryByLabelText('CRF')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: /Розширені налаштування/ })[0]);
    expect(dispatch).toHaveBeenCalledWith({ type: 'toggle-disclosure' });
  });
});
