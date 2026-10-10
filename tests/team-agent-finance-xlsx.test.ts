import { expect, it } from 'vitest';
import yauzl from 'yauzl';
import {
  buildFinanceWorkbook,
  financeWorkbookSheets
} from '../supabase/functions/_shared/finance-workbook';
import { buildWorkbook } from '../supabase/functions/_shared/xlsx';
import type { FinanceSnapshot } from '@video-compressor/shared';

export const workbookFixture: FinanceSnapshot = {
  schemaVersion: 1,
  teamId: '27000000-0000-4000-8000-000000000010',
  teamName: '=Team',
  from: '2026-09-01',
  to: '2026-09-30',
  currency: 'USD',
  generatedAt: '2026-10-03T10:00:00Z',
  accounts: [{ id: 'x', name: 'X' }],
  agents: [
    { id: 'a', agentId: '001234' },
    { id: 'b', agentId: '=SUM(A1)' }
  ],
  placements: [
    {
      id: 'p',
      agentRowId: 'a',
      accountId: 'x',
      startsOn: '2026-01-01',
      endsOn: null,
      version: '1'
    },
    { id: 'q', agentRowId: 'b', accountId: 'x', startsOn: '2026-01-01', endsOn: null, version: '1' }
  ],
  fields: [
    {
      agentRowId: 'a',
      date: '2026-09-01',
      metric: 'spend',
      value: '0.00',
      currency: 'USD',
      version: '1',
      placementId: 'p',
      updatedAt: '2026-09-01T10:00:00Z',
      updatedBy: null
    },
    {
      agentRowId: 'a',
      date: '2026-09-02',
      metric: 'topup',
      value: '100.25',
      currency: 'USD',
      version: '1',
      placementId: 'p',
      updatedAt: '2026-09-02T10:00:00Z',
      updatedBy: null
    }
  ]
};

function unzip(bytes: Uint8Array): Promise<Map<string, string>> {
  return new Promise((resolve, reject) =>
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const files = new Map<string, string>();
      zip.readEntry();
      zip.on('entry', entry =>
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return reject(error);
          const chunks: Buffer[] = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
          stream.on('error', reject);
        })
      );
      zip.on('end', () => resolve(files));
      zip.on('error', reject);
    })
  );
}
it('writes five independently readable sheets, frozen merged headers, blank cells and literal IDs', async () => {
  const files = await unzip(await buildFinanceWorkbook(workbookFixture));
  expect([...files.keys()].filter(n => n.startsWith('xl/worksheets/'))).toHaveLength(5);
  const sheet = files.get('xl/worksheets/sheet1.xml')!;
  expect(sheet).toContain('ref="B4:C4"');
  expect(sheet).toContain('state="frozen"');
  expect(sheet).toContain('<v>0.00</v>');
  expect(sheet).toContain('s="0"><v>0.00</v>');
  expect(files.get('xl/worksheets/sheet2.xml')).toContain('s="1"><v>100.25</v>');
  expect(sheet).toContain('ySplit="5"');
  expect(sheet).not.toContain('r="B7"');
  expect(files.get('xl/sharedStrings.xml')).toContain('001234');
  expect(files.get('xl/sharedStrings.xml')).toContain('=SUM(A1)');
  for (const xml of files.values()) expect(xml).not.toContain('<f>');
  const sheets = financeWorkbookSheets(workbookFixture);
  expect(sheets[2]!.rows).toHaveLength(35);
  expect(sheets[3]!.rows[1]![3]).toEqual({ t: 'decimal', v: '100.25' });
});
it('refuses decimal precision loss instead of silently rounding', async () => {
  await expect(
    buildWorkbook([{ sheetName: 'Spend', rows: [[{ t: 'decimal', v: '100000000000000.01' }]] }])
  ).rejects.toThrow(/PRECISION/);
});

it('keeps one column per social account and agent when an agent returns X → Y → X', async () => {
  const placement = (id: string, accountId: string, startsOn: string, endsOn: string | null) => ({
    id,
    agentRowId: 'a',
    accountId,
    startsOn,
    endsOn,
    version: '1'
  });
  const topup = (date: string, placementId: string, value: string) => ({
    agentRowId: 'a',
    date,
    metric: 'topup' as const,
    value,
    currency: 'USD' as const,
    version: '1',
    placementId,
    updatedAt: `${date}T10:00:00Z`,
    updatedBy: null
  });
  const snapshot: FinanceSnapshot = {
    ...workbookFixture,
    teamName: 'Team',
    accounts: [
      { id: 'x', name: 'X' },
      { id: 'y', name: 'Y' }
    ],
    agents: [{ id: 'a', agentId: '001234' }],
    placements: [
      placement('p1', 'x', '2026-01-01', '2026-09-10'),
      placement('p2', 'y', '2026-09-10', '2026-09-20'),
      placement('p3', 'x', '2026-09-20', null)
    ],
    fields: [
      topup('2026-09-05', 'p1', '10.00'),
      topup('2026-09-15', 'p2', '20.00'),
      topup('2026-09-25', 'p3', '30.50')
    ]
  };
  const [, topups, , statement] = financeWorkbookSheets(snapshot);
  // Two columns — X/001234 and Y/001234 — not a second X column for the return.
  expect(topups!.rows[3]).toEqual([
    { t: 'string', v: 'Дата · USD' },
    { t: 'string', v: 'X' },
    { t: 'string', v: 'Y' }
  ]);
  expect(topups!.rows[4]!.slice(1)).toEqual([
    { t: 'string', v: '001234' },
    { t: 'string', v: '001234' }
  ]);
  // Both stays in X add up in the one X column; Y keeps its own day.
  const total = topups!.rows.at(-1)!;
  expect(total.slice(1)).toEqual([
    { t: 'decimal', v: '40.50' },
    { t: 'decimal', v: '20.00' }
  ]);
  // The statement names the social account the agent sat in on each day.
  expect(statement!.rows.slice(1, 4).map(row => [row[0], row[1]])).toEqual([
    [
      { t: 'string', v: '2026-09-05' },
      { t: 'string', v: 'X' }
    ],
    [
      { t: 'string', v: '2026-09-15' },
      { t: 'string', v: 'Y' }
    ],
    [
      { t: 'string', v: '2026-09-25' },
      { t: 'string', v: 'X' }
    ]
  ]);
  const files = await unzip(await buildFinanceWorkbook(snapshot));
  expect(files.get('xl/worksheets/sheet2.xml')).not.toContain('r="D4"');
});

it('refuses a workbook wider than a spreadsheet allows instead of truncating it', async () => {
  const row = Array.from({ length: 16385 }, () => ({ t: 'string' as const, v: '' }));
  await expect(buildWorkbook([{ sheetName: 'Spend', rows: [row] }])).rejects.toThrow(
    'FINANCE_EXPORT_SIZE'
  );
  await expect(
    buildWorkbook([
      { sheetName: 'Same', rows: [] },
      { sheetName: 'Same', rows: [] }
    ])
  ).rejects.toThrow('FINANCE_EXPORT_SIZE');
});
