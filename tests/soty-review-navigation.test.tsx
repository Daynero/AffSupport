// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import ReviewApp from '../apps/soty-review/src/ReviewApp.js';

describe('Soty review navigation', () => {
  beforeEach(() => {
    location.hash = '#/catalog?theme=light&locale=uk';
  });

  it('shows iteration and opens a stable screen reference', () => {
    render(<ReviewApp />);
    expect(screen.getAllByText(/soty-ui-r01/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Стиснення відео'));
    expect(screen.getByRole('heading', { name: 'Стиснення відео', level: 1 })).toBeTruthy();
    expect(
      document.querySelector('[data-review-id^="soty-ui-r01/compressor/default"]')
    ).toBeTruthy();
  });

  it('recovers an invalid direct link to the catalog', () => {
    location.hash = '#/screen/unknown?state=bad';
    render(<ReviewApp />);
    expect(screen.getByText(/Екран не знайдено/)).toBeTruthy();
  });
});
