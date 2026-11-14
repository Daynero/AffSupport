// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CatalogCreationVideoFields } from '../apps/web/src/team/product-catalog/CatalogCreationVideoFields';
import { catalogPublicationFirstDay } from '../apps/web/src/team/product-catalog/catalogPublicationDraft';
afterEach(cleanup);
const draft = {
  variationCount: '1',
  delayed: true,
  date: '2027-11-12',
  time: '11:39',
  zone: 'Europe/Kyiv',
  occurrence: 'earlier' as const
};
it('keeps scheduling compact and opens the shared calendar only when editing the date', () => {
  const onChange = vi.fn();
  render(
    <CatalogCreationVideoFields
      value={draft}
      onChange={onChange}
      restitch={false}
      productCount={3}
      disabled={false}
    />
  );
  expect(screen.queryByRole('grid')).toBeNull();
  expect(screen.getByLabelText('Time')).toHaveProperty('value', '11:39');
  expect(screen.getByRole('button', { name: /Time zone/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /When the clock repeats/ })).toBeNull();
  const date = screen.getByRole('button', { name: /Link publication date:/ });
  fireEvent.click(date);
  expect(screen.getByRole('grid')).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape', keyCode: 27 });
  expect(screen.queryByRole('grid')).toBeNull();
  expect(document.activeElement).toBe(date);
  expect(onChange).not.toHaveBeenCalled();
});
it('renders today with the shared calendar day marker while keeping the selection separate', () => {
  const today = catalogPublicationFirstDay('Europe/Kyiv');
  render(
    <CatalogCreationVideoFields
      value={{ ...draft, date: today.add({ days: 1 }).toString() }}
      onChange={vi.fn()}
      restitch={false}
      productCount={3}
      disabled={false}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: /Link publication date:/ }));
  const marked = document.querySelector('.ui-calendar-day[data-today] .calendar__cell-button');
  expect(marked?.textContent).toBe(String(today.day));
  const selected = document.querySelector('.ui-calendar-day[data-selected] .calendar__cell-button');
  expect(selected).not.toBe(marked);
});
