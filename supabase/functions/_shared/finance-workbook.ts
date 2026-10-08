import { buildFinanceReport } from '../../../packages/shared/dist/team/agent-finance-report.js';
import type {
  FinanceSnapshot,
  FinanceMetric
} from '../../../packages/shared/dist/team/agent-finance.js';
import { buildWorkbook, columnName, type XlsxCell, type XlsxSheet } from './xlsx.ts';

const text = (v: string): XlsxCell => ({ t: 'string', v });
const amount = (v: string | null): XlsxCell => (v === null ? text('') : { t: 'decimal', v });
export function financeWorkbookSheets(snapshot: FinanceSnapshot): XlsxSheet[] {
  const report = buildFinanceReport(snapshot);
  if (report.columns.length > 16383) throw new RangeError('FINANCE_EXPORT_SIZE');
  const merges: string[] = [];
  for (let start = 0; start < report.columns.length;) {
    let end = start + 1;
    while (
      end < report.columns.length &&
      report.columns[end]!.accountId === report.columns[start]!.accountId
    )
      end++;
    if (end - start > 1) merges.push(`${columnName(start + 1)}4:${columnName(end)}4`);
    start = end;
  }
  const matrix = (metric: FinanceMetric, sheetName: string): XlsxSheet => ({
    sheetName,
    freezeRows: 5,
    freezeColumns: 1,
    merges,
    rows: [
      [text('Простір'), text(snapshot.teamName)],
      [text('Період · USD'), text(`${snapshot.from} — ${snapshot.to}`)],
      [text('Створено'), text(snapshot.generatedAt)],
      [text('Дата · USD'), ...report.columns.map(c => text(c.accountName))],
      [text('РК'), ...report.columns.map(c => text(c.agentId))],
      ...report.dates.map(date => [
        text(date),
        ...report.columns.map(c => amount(report.cell(c.accountId, c.agentRowId, date, metric)))
      ]),
      ...(metric === 'balance'
        ? []
        : [[text('Разом'), ...report.columns.map(c => amount(c.totals[metric]))]])
    ]
  });
  return [
    matrix('spend', 'Витрати'),
    matrix('topup', 'Поповнення'),
    matrix('balance', 'Залишок'),
    {
      sheetName: 'Виписка поповнень',
      freezeRows: 1,
      rows: [
        [text('Дата'), text('Соц'), text('РК'), text('Сума · USD')],
        ...report.topups.map(r => [
          text(r.date),
          text(r.accountName),
          text(r.agentId),
          amount(r.value)
        ]),
        [text('Разом'), text(''), text(''), amount(report.totals.topup)]
      ]
    },
    {
      sheetName: 'Підсумки',
      freezeRows: 1,
      rows: [
        [text('Рівень'), text('Назва / ID'), text('Витрати · USD'), text('Поповнення · USD')],
        [
          text('Простір'),
          text(snapshot.teamName),
          amount(report.totals.spend),
          amount(report.totals.topup)
        ],
        ...report.accounts.map(a => [
          text('Соц'),
          text(a.name),
          amount(a.totals.spend),
          amount(a.totals.topup)
        ]),
        ...report.agents.map(a => [
          text('РК'),
          text(a.agentId),
          amount(a.totals.spend),
          amount(a.totals.topup)
        ]),
        [text('Період'), text(`${snapshot.from} — ${snapshot.to}`)],
        [text('Створено'), text(snapshot.generatedAt)]
      ]
    }
  ];
}
export async function buildFinanceWorkbook(snapshot: FinanceSnapshot) {
  return buildWorkbook(financeWorkbookSheets(snapshot));
}
