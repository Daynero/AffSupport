// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from 'react-aria-components';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CatalogCreatedFilter,
  type CatalogCreatedRange
} from '../apps/web/src/team/catalog-updater/CatalogCreatedFilter';

vi.mock('../apps/web/src/i18n', () => ({
  useI18n: () => ({
    language: 'en',
    t: (key: string, values?: { date: string }) => (values ? `${key} ${values.date}` : key)
  })
}));

afterEach(cleanup);

function Control({
  initial,
  changed
}: {
  initial: CatalogCreatedRange;
  changed: ReturnType<typeof vi.fn>;
}) {
  const [value, setValue] = useState(initial);
  return (
    <I18nProvider locale="en-US">
      <CatalogCreatedFilter
        value={value}
        onChange={next => {
          changed(next);
          setValue(next);
        }}
      />
    </I18nProvider>
  );
}

it('commits a finished calendar range and closes the popover', async () => {
  const changed = vi.fn();
  render(<Control initial={{ from: '2026-09-10', to: '2026-09-14' }} changed={changed} />);
  await userEvent.click(screen.getByRole('button', { name: /^catalogCreatedFilter/ }));
  await userEvent.click(screen.getByRole('button', { name: /September 11, 2026/ }));
  expect(changed).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: /September 17, 2026/ }));
  expect(changed).toHaveBeenLastCalledWith({ from: '2026-09-11', to: '2026-09-17' });
  expect(screen.queryByLabelText('catalogCreatedChooseRange')).toBeNull();
});

it('shows only the shared calendar and clears the selected period from its chip', async () => {
  const changed = vi.fn();
  render(<Control initial={{ from: '2026-09-10', to: '2026-09-14' }} changed={changed} />);
  await userEvent.click(screen.getByRole('button', { name: /^catalogCreatedFilter/ }));
  expect(screen.queryByLabelText('catalogCreatedFrom')).toBeNull();
  expect(screen.queryByLabelText('catalogCreatedTo')).toBeNull();
  expect(screen.queryByRole('button', { name: 'catalogCreatedOlder30' })).toBeNull();
  expect(screen.getAllByRole('button', { name: 'catalogCreatedClear' })).toHaveLength(1);
  await userEvent.keyboard('{Escape}');
  await userEvent.click(screen.getByRole('button', { name: 'catalogCreatedClear' }));
  expect(changed).toHaveBeenLastCalledWith({ from: '', to: '' });
});
