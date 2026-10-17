// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LaunchDefaultsReview } from '../apps/web/src/team/launches/LaunchDefaultsReview';
import { launchConfig } from './fixtures/launches';
afterEach(cleanup);
it('shows current defaults and ordered SUB without exposing unrelated Launch content', () => {
  const config = launchConfig({ originalUrl: 'SYNTHETIC_PRIVATE_URL' });
  const reviewed = vi.fn();
  render(
    <LaunchDefaultsReview
      current={{
        config,
        subConfig: {
          schemaVersion: 1,
          sub1: ['buyer'],
          sub2: ['creative', 'social'],
          sub3: []
        }
      }}
      buyer="other_buyer"
      disabled={false}
      onReview={reviewed}
    />
  );
  expect(screen.getByText('other_buyer')).toBeTruthy();
  expect(screen.getByText('Creative → Social account')).toBeTruthy();
  expect(screen.queryByText('SYNTHETIC_PRIVATE_URL')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Reviewed; keep my Launch draft' }));
  expect(reviewed).toHaveBeenCalledOnce();
});
it('cannot acknowledge while a mutation is unsettled', () => {
  const reviewed = vi.fn();
  render(<LaunchDefaultsReview current={null} buyer="" disabled onReview={reviewed} />);
  expect(screen.getByText('No workspace defaults are saved.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Reviewed; keep my Launch draft' }));
  expect(reviewed).not.toHaveBeenCalled();
});
