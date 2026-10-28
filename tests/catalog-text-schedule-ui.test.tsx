// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProductCatalogSettingsSection,
  type ProductCatalogSettingsClient,
  type ProductCatalogTextSchedule
} from '../apps/web/src/team/product-catalog/ProductCatalogSettingsSection';

vi.mock('../apps/web/src/analytics/service', () => ({ analytics: { track: vi.fn() } }));
vi.mock('../apps/web/src/team/TeamContext', () => ({ useTeam: () => ({ can: () => true }) }));
vi.mock('../apps/web/src/components/toast', () => ({ useToasts: () => ({ push: vi.fn() }) }));
beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
function makeClient() {
  let schedule: ProductCatalogTextSchedule = {
    enabled: false,
    count: 200,
    nextRunAt: null,
    lastRunAt: null,
    lastError: null
  };
  const client: ProductCatalogSettingsClient = {
    getProductCatalogSettings: vi.fn().mockResolvedValue(null),
    setProductCatalogSettings: vi.fn(),
    listProductCatalogTexts: vi.fn().mockResolvedValue([]),
    replaceProductCatalogTexts: vi.fn(),
    getProductCatalogTextSchedule: vi.fn(async () => ({ ...schedule })),
    setProductCatalogTextSchedule: vi.fn(async (_team, next) => {
      schedule = {
        ...schedule,
        ...next,
        nextRunAt: next.enabled ? '2026-11-11T12:00:00.000Z' : null
      };
      return { ...schedule };
    })
  };
  return client;
}
async function openNames() {
  await userEvent.click(
    document.querySelector<HTMLButtonElement>(
      'button[aria-controls="accordion-product-catalog-texts-title"]'
    )!
  );
}
describe('weekly catalog text regeneration settings', () => {
  it('starts with 200, preserves a draft, and shows only the confirmed server schedule without generating immediately', async () => {
    const client = makeClient();
    const changed = vi.fn();
    render(
      <ProductCatalogSettingsSection teamId="space" client={client} onDraftChange={changed} />
    );
    await openNames();
    const toggle = await screen.findByRole('switch', { name: 'Regenerate weekly' });
    expect(toggle).toHaveProperty('checked', false);
    await userEvent.click(toggle);
    expect(screen.getByLabelText('New variants')).toHaveProperty('value', '200');
    expect(client.setProductCatalogTextSchedule).not.toHaveBeenCalled();
    expect(screen.queryByText(/Next update:/)).toBeNull();
    await waitFor(() => expect(changed).toHaveBeenLastCalledWith({ dirty: true, saving: false }));
    await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await screen.findByText('Schedule saved');
    expect(client.setProductCatalogTextSchedule).toHaveBeenCalledWith('space', {
      enabled: true,
      count: 200
    });
    expect(client.getProductCatalogTextSchedule).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Next update:/)).toBeTruthy();
    expect(client.replaceProductCatalogTexts).not.toHaveBeenCalled();
  });

  it('does not represent a failed read as disabled and offers a read retry', async () => {
    const client = makeClient();
    client.getProductCatalogTextSchedule = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({
        enabled: false,
        count: 200,
        nextRunAt: null,
        lastRunAt: null,
        lastError: null
      });
    render(<ProductCatalogSettingsSection teamId="space" client={client} />);
    await openNames();
    await screen.findByRole('alert');
    expect(screen.queryByRole('switch', { name: 'Regenerate weekly' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('switch', { name: 'Regenerate weekly' });
    expect(client.setProductCatalogTextSchedule).not.toHaveBeenCalled();
  });

  it('validates count and saves an explicitly configured weekly quantity', async () => {
    const client = makeClient();
    render(<ProductCatalogSettingsSection teamId="space" client={client} />);
    await openNames();
    await userEvent.click(await screen.findByRole('switch', { name: 'Regenerate weekly' }));
    const amount = screen.getByLabelText('New variants');
    await userEvent.clear(amount);
    await userEvent.type(amount, '1001');
    expect(screen.getByRole('button', { name: 'Save schedule' })).toHaveProperty('disabled', true);
    await userEvent.clear(amount);
    await userEvent.type(amount, '350');
    await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await screen.findByText('Schedule saved');
    expect(client.setProductCatalogTextSchedule).toHaveBeenCalledWith('space', {
      enabled: true,
      count: 350
    });
  });

  it('keeps the draft and never reports success when readback disagrees', async () => {
    const client = makeClient();
    client.setProductCatalogTextSchedule = vi.fn().mockResolvedValue({
      enabled: true,
      count: 200,
      nextRunAt: '2026-11-11T12:00:00.000Z',
      lastRunAt: null,
      lastError: null
    });
    render(<ProductCatalogSettingsSection teamId="space" client={client} />);
    await openNames();
    await userEvent.click(await screen.findByRole('switch', { name: 'Regenerate weekly' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('Schedule saved')).toBeNull();
    expect(screen.queryByText(/Next update:/)).toBeNull();
    expect(screen.getByRole('switch', { name: 'Regenerate weekly' })).toHaveProperty(
      'checked',
      true
    );
  });
});
