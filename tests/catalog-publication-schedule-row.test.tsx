// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { CatalogPublicationSchedule } from '../apps/web/src/team/product-catalog/CatalogPublicationSchedule';

afterEach(cleanup);

const css = readFileSync(path.resolve(import.meta.dirname, '../apps/web/src/styles.css'), 'utf8');

/** Every rule whose selector names the schedule, as `selector { body }` pairs. */
function scheduleRules(): { selector: string; body: string }[] {
  return [...css.matchAll(/([^{}]*catalog-publication-schedule[^{}]*)\{([^}]*)\}/gu)].map(
    match => ({ selector: match[1]!.trim(), body: match[2]! })
  );
}

// 1.4.3 on next: the field name was nowrap and the chosen time sat in the same row
// with no room of its own, so «Дата додавання посилання» ran under
// «12 лист. 2026 р., 11:39 · Київ — GMT+02:00».
it('renders the field name and the chosen time as two separate items', () => {
  render(
    <CatalogPublicationSchedule
      enabled
      disabled={false}
      date="2026-11-12"
      time="11:39"
      zone="Europe/Kyiv"
      onChange={() => {}}
    >
      <span />
    </CatalogPublicationSchedule>
  );
  const toggle = screen.getByRole('button', { expanded: false });
  const label = toggle.querySelector('.catalog-publication-label');
  const when = toggle.querySelector('.catalog-publication-when');
  expect(label).not.toBeNull();
  expect(when).not.toBeNull();
  expect(label).not.toBe(when);
  expect(label!.contains(when)).toBe(false);
  expect(when!.textContent).toContain('11:39');
  // A clipped or wrapped time still reads in full on hover.
  expect(when!.getAttribute('title')).toBe(when!.textContent);
});

it('lets the row wrap and never forces the name onto one unshrinkable line', () => {
  const rules = scheduleRules();
  expect(rules.some(rule => /white-space:\s*nowrap/u.test(rule.body))).toBe(false);
  const row = rules.find(rule =>
    /\.catalog-publication-schedule \.settings-collapse$/u.test(rule.selector)
  );
  expect(row?.body).toMatch(/flex-wrap:\s*wrap/u);
  const when = rules.find(rule => rule.selector.endsWith('.catalog-publication-when'));
  expect(when?.body).toMatch(/min-width:\s*0/u);
  expect(when?.body).toMatch(/overflow-wrap:\s*anywhere/u);
});
