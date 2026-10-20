import { JSDOM, VirtualConsole } from 'jsdom';
import { expect, it } from 'vitest';
import { renderCatalogScheduleReport } from '../scripts/analytics/catalog-schedule-report';

export const reportFixture = {
  period: { start: '2026-10-13T00:00:00Z', end: '2026-10-20T00:00:00Z', timezone: 'UTC' },
  scope: { mode: 'all', user_id: null },
  totals: {
    confirmed_changes: 4,
    interval_changes: 4,
    distinct_actors: 2,
    unknown_actor_changes: 0
  },
  current: {
    catalogs: 3,
    known_last_editors: 2,
    unknown_last_editors: 1,
    distribution: [
      { interval: '1h', catalogs: 2 },
      { interval: '1d', catalogs: 1 }
    ]
  },
  popularity: [
    { interval: '1h', selections: 3, distinct_actors: 2 },
    { interval: 'off', selections: 1, distinct_actors: 1 }
  ],
  daily: [
    { date: '2026-10-18', confirmed_changes: 2 },
    { date: '2026-10-19', confirmed_changes: 2 }
  ],
  interval_daily_endstate: [
    { date: '2026-10-18', interval: '1d', catalogs: 3 },
    { date: '2026-10-19', interval: '1h', catalogs: 2 },
    { date: '2026-10-19', interval: '1d', catalogs: 1 }
  ],
  transitions: [{ from: '1d', to: '1h', changes: 3 }],
  custom_hours: [{ hours: 6, catalogs: 1 }],
  options: [{ field: 'restitch', enabled_catalogs: 2 }],
  schedule_clock: [
    { time: '09:00', weekday: 1, time_zone: 'Europe/Kyiv', catalogs: 1, confirmed_selections: 1 }
  ],
  users: [
    {
      user_id: 'user-one',
      confirmed_changes: 2,
      catalogs_changed: 1,
      first_observed: { at: '2026-10-18T09:00:00Z', interval: '1d' },
      latest_observed: { at: '2026-10-19T09:00:00Z', interval: '1h' },
      timeline: [
        {
          at: '2026-10-18T09:00:00Z',
          catalog_id: 'catalog-one',
          from: 'off',
          to: '1d',
          options_changed: []
        },
        {
          at: '2026-10-19T09:00:00Z',
          catalog_id: 'catalog-one',
          from: '1d',
          to: '1h',
          options_changed: []
        }
      ]
    },
    {
      user_id: 'user-two',
      confirmed_changes: 1,
      catalogs_changed: 1,
      first_observed: { at: '2026-10-18T10:00:00Z', interval: '1h' },
      latest_observed: { at: '2026-10-18T10:00:00Z', interval: '1h' },
      timeline: [
        {
          at: '2026-10-18T10:00:00Z',
          catalog_id: 'catalog-two',
          from: '1d',
          to: '1h',
          options_changed: []
        }
      ]
    }
  ],
  coverage: {
    observed_since: '2026-10-18T00:00:00Z',
    notes: ['Before collection is unknown.'],
    unknown_actor_changes: 0
  },
  truncation: { users_returned: 2, users_total: 2, timeline_returned: 3, timeline_total: 3 }
};
it('renders offline charts and separate user/catalog change tracks with explicit coverage', () => {
  const errors: Error[] = [];
  const console = new VirtualConsole();
  console.on('jsdomError', e => errors.push(e));
  const dom = new JSDOM(renderCatalogScheduleReport(reportFixture), {
    runScripts: 'dangerously',
    virtualConsole: console
  });
  expect(errors).toEqual([]);
  const d = dom.window.document;
  expect(d.querySelectorAll('svg[role="img"]').length).toBeGreaterThanOrEqual(8);
  expect(d.querySelector('#coverage')!.textContent).toContain('невідома');
  expect(d.querySelector('#users')!.textContent).toContain('user-one');
  const select = d.querySelector('select')!;
  select.value = 'user-two';
  select.dispatchEvent(new dom.window.Event('change'));
  expect(d.querySelector('#users')!.textContent).not.toContain('user-one');
  expect(d.querySelector('#users')!.textContent).toContain('user-two');
  expect(d.querySelectorAll('script[src],link[href],img[src]').length).toBe(0);
  dom.window.close();
});
it('escapes script-breaking content and renders honest empty evidence', () => {
  const html = renderCatalogScheduleReport({
    coverage: { notes: ['</script><img src=x onerror=alert(1)>'] }
  });
  expect(html).not.toContain('</script><img');
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  expect(dom.window.document.querySelector('img')).toBeNull();
  expect(dom.window.document.body.textContent).toContain('Поки немає підтверджених даних');
  dom.window.close();
});
