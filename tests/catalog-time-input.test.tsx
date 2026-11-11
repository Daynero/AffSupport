// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import {
  CatalogTimeInput,
  normalizeCatalogTime
} from '../apps/web/src/team/product-catalog/CatalogTimeInput';

afterEach(cleanup);

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <CatalogTimeInput aria-label="Time" value={value} onChange={setValue} />;
}

it('asks for a 24-hour time whatever the browser locale is', () => {
  render(<Harness />);
  const input = screen.getByLabelText('Time') as HTMLInputElement;
  // A native time field draws "--:-- AM" on an English browser.
  expect(input.type).toBe('text');
  expect(input.inputMode).toBe('numeric');
  fireEvent.change(input, { target: { value: '18:30' } });
  expect(input.value).toBe('18:30');
});

it('reads a shorthand time on leaving the field', () => {
  render(<Harness />);
  const input = screen.getByLabelText('Time') as HTMLInputElement;
  fireEvent.change(input, { target: { value: '930' } });
  fireEvent.blur(input);
  expect(input.value).toBe('09:30');
});

it('keeps only digits and a colon', () => {
  render(<Harness />);
  const input = screen.getByLabelText('Time') as HTMLInputElement;
  fireEvent.change(input, { target: { value: '2 PM' } });
  expect(input.value).toBe('2');
});

it('normalizes only what it can read without guessing', () => {
  expect(normalizeCatalogTime('9:05')).toBe('09:05');
  expect(normalizeCatalogTime('1430')).toBe('14:30');
  expect(normalizeCatalogTime('14:30')).toBe('14:30');
  expect(normalizeCatalogTime('9:5')).toBe('9:5');
  expect(normalizeCatalogTime('')).toBe('');
});
