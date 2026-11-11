// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CatalogRowPublicationNote } from '../apps/web/src/team/catalog-updater/CatalogRowPublicationNote';

/** 1.4.3 QA: the manager row showed nothing for a catalog whose link was deferred. */
beforeEach(() => localStorage.setItem('language', 'uk'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});
const now = Date.parse('2026-11-11T15:00:00Z');

it('names today’s link time in the publication zone', () => {
  render(
    <CatalogRowPublicationNote
      now={now}
      publication={{
        dueAt: '2026-11-11T17:42:00Z',
        timeZone: 'Europe/Kyiv',
        waitingForVideos: false
      }}
    />
  );
  expect(screen.getByRole('status').textContent).toBe('Посилання о 19:42');
});

it('names the day when the link is not due today', () => {
  render(
    <CatalogRowPublicationNote
      now={now}
      publication={{
        dueAt: '2026-11-12T10:00:00Z',
        timeZone: 'Europe/Kyiv',
        waitingForVideos: true
      }}
    />
  );
  const text = screen.getByRole('status').textContent ?? '';
  expect(text).toMatch(/^Посилання 12 /u);
  expect(text).toMatch(/о 12:00$/u);
});

it('says the link waits for its videos once its time has come', () => {
  render(
    <CatalogRowPublicationNote
      now={now}
      publication={{
        dueAt: '2026-11-11T14:42:00Z',
        timeZone: 'Europe/Kyiv',
        waitingForVideos: true
      }}
    />
  );
  expect(screen.getByRole('status').textContent).toBe('Посилання чекає на відео');
});
