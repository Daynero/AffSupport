// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LaunchPendingResult } from '../apps/web/src/team/launches/LaunchPendingResult.js';
import { launchConfig, launchSources } from './fixtures/launches.js';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('renders copyable deterministic names before URLs exist without a fabricated revision', async () => {
  const config = launchConfig({ method: 'catalog' });
  const sources = {
    ...launchSources,
    schemaVersion: 1 as const,
    agentRowId: config.agentRowId,
    offerId: config.offerId,
    buyerId: config.buyerId,
    materialId: config.materialId,
    catalogSettingsVersion: null
  };
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: write }
  });
  const copied = vi.fn();
  const outcome = vi.fn();
  const view = render(
    <LaunchPendingResult
      config={config}
      sources={sources}
      onCopied={copied}
      onCopyOutcome={outcome}
    />
  );
  expect(screen.getByText('Reserving catalog name…')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Copy Catalog URL' })).toBeNull();
  const copy = screen.getAllByRole('button', { name: /Copy Campaign name/ })[0];
  fireEvent.click(copy);
  await waitFor(() => expect(write).toHaveBeenCalledOnce());
  expect(copy.textContent).toContain('Copied');
  expect(copied).toHaveBeenCalledWith('campaign:1', write.mock.calls[0][0]);
  expect(outcome).toHaveBeenCalledWith('campaign_name', 'success');
  view.rerender(
    <LaunchPendingResult config={config} sources={sources} catalogName="Reserved V2" />
  );
  expect(screen.getByRole('button', { name: 'Copy Catalog name' }).textContent).toContain(
    'Reserved V2'
  );
});

it('reports a denied preview clipboard write without a copied mark or user content', async () => {
  const outcome = vi.fn(),
    copied = vi.fn();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }
  });
  render(
    <LaunchPendingResult
      config={launchConfig({ method: 'catalog' })}
      sources={null}
      catalogName="Private reserved name"
      onCopied={copied}
      onCopyOutcome={outcome}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Copy Catalog name' }));
  await waitFor(() => expect(outcome).toHaveBeenCalledWith('catalog_name', 'failure'));
  expect(copied).not.toHaveBeenCalled();
  expect(document.querySelector('.launch-result-copied')).toBeNull();
  expect(JSON.stringify(outcome.mock.calls)).not.toContain('Private');
});
