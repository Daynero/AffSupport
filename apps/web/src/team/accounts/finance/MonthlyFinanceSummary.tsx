import { type CSSProperties, useId, useLayoutEffect, useRef, useState } from 'react';
import type { buildFinanceReport, FinanceMetric } from '@video-compressor/shared';
import {
  Button,
  Select,
  Tabs,
  Table,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TableCell
} from '../../../components/ui/index';
import { useI18n } from '../../../i18n';
import { formatFinanceAmount } from './formatFinanceAmount';
import { FinanceTopupStatement } from './FinanceTopupStatement';
import { AgentIdentity } from '../AgentIdentity';

export interface MonthlyFinanceContext {
  metric: FinanceMetric;
  view: string;
  scrollLeft: number;
  scrollTop: number;
  focusedDay?: string;
}

export function MonthlyFinanceSummary({
  report,
  onDay,
  today,
  initialContext,
  onContextChange
}: {
  report: ReturnType<typeof buildFinanceReport>;
  onDay: (day: string) => void;
  today?: string;
  initialContext?: MonthlyFinanceContext;
  onContextChange?: (context: MonthlyFinanceContext) => void;
}) {
  const { t } = useI18n();
  const [metric, setMetric] = useState<FinanceMetric>(initialContext?.metric ?? 'spend');
  const id = useId();
  const [view, setView] = useState(initialContext?.view ?? 'matrix');
  const scroll = useRef<HTMLDivElement>(null);
  const context = useRef<MonthlyFinanceContext>(
    initialContext ?? { metric: 'spend', view: 'matrix', scrollLeft: 0, scrollTop: 0 }
  );
  const update = (next: Partial<MonthlyFinanceContext>) => {
    context.current = { ...context.current, ...next };
    onContextChange?.(context.current);
  };
  useLayoutEffect(() => {
    const region = scroll.current;
    if (!region) return;
    region.scrollLeft = context.current.scrollLeft;
    region.scrollTop = context.current.scrollTop;
    if (context.current.focusedDay)
      region
        .querySelector<HTMLButtonElement>(`[data-finance-day="${context.current.focusedDay}"]`)
        ?.focus({ preventScroll: true });
  }, [view]);
  useLayoutEffect(() => {
    const region = scroll.current;
    if (!region) return;
    const resize = () => {
      region.style.setProperty('--finance-table-top', `${region.getBoundingClientRect().top}px`);
    };
    resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    if (region.parentElement) observer?.observe(region.parentElement);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [view]);
  const items = [
    { id: `${id}-matrix`, label: t('financeMatrix') },
    { id: `${id}-summary`, label: t('financeSummary') },
    { id: `${id}-statement`, label: t('financeStatement') }
  ];
  return (
    <section className="flex flex-col gap-4">
      <Tabs
        label={t('financeTitle')}
        value={`${id}-${view}`}
        items={items}
        onChange={value => {
          const next = value.slice(id.length + 1);
          setView(next);
          update({ view: next });
        }}
        panelId={value => `${value}-panel`}
        size="sm"
      />
      <div
        role="tabpanel"
        id={`${id}-${view}-panel`}
        aria-labelledby={`tab-${id}-${view}`}
        className="flex flex-col gap-4"
      >
        {view === 'matrix' && (
          <>
            <Select
              aria-label={t('financeTitle')}
              value={metric}
              onChange={v => {
                if (v === 'balance' || v === 'topup' || v === 'spend') {
                  setMetric(v);
                  update({ metric: v });
                }
              }}
              options={[
                { value: 'spend', label: t('financeSpend') },
                { value: 'topup', label: t('financeTopup') },
                { value: 'balance', label: t('financeBalance') }
              ]}
            />
            <div
              className="finance-matrix-scroll overflow-auto"
              style={
                {
                  // Grid tracks can overflow their row without increasing its width.
                  // Size the whole matrix, including empty/new agent columns.
                  '--finance-agent-count': Math.max(1, report.columns.length)
                } as CSSProperties
              }
              tabIndex={0}
              role="region"
              aria-label={t('financeMatrix')}
              ref={scroll}
              onScroll={event =>
                update({
                  scrollLeft: event.currentTarget.scrollLeft,
                  scrollTop: event.currentTarget.scrollTop
                })
              }
            >
              <Table
                label={t(
                  metric === 'balance'
                    ? 'financeBalance'
                    : metric === 'topup'
                      ? 'financeTopup'
                      : 'financeSpend'
                )}
                stickyHeader
                className="finance-matrix w-full"
                columns={`var(--finance-date-column-width) repeat(${Math.max(1, report.columns.length)}, minmax(var(--finance-agent-column-width), 1fr))`}
              >
                <TableHeader>
                  <TableHeaderCell className="finance-matrix-date">
                    {t('financeDate')}
                  </TableHeaderCell>
                  {report.columns.map(c => (
                    <TableHeaderCell key={`${c.accountId}/${c.agentRowId}`}>
                      <AgentIdentity accountName={c.accountName} agentId={c.agentId} />
                    </TableHeaderCell>
                  ))}
                </TableHeader>
                {report.dates.map(day => (
                  <TableRow key={day}>
                    <TableCell className="finance-matrix-date">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={Boolean(today && day > today)}
                        data-finance-day={day}
                        onClick={() => {
                          update({ focusedDay: day });
                          onDay(day);
                        }}
                      >
                        {day}
                      </Button>
                    </TableCell>
                    {report.columns.map(c => (
                      <TableCell key={`${c.accountId}/${c.agentRowId}`}>
                        {formatFinanceAmount(
                          report.cell(c.accountId, c.agentRowId, day, metric),
                          ''
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {metric !== 'balance' && (
                  <TableRow className="finance-matrix-total">
                    <TableCell className="finance-matrix-date">
                      {t(metric === 'spend' ? 'financeSpend' : 'financeTopup')}
                    </TableCell>
                    {report.columns.map(c => (
                      <TableCell key={`${c.accountId}/${c.agentRowId}`}>
                        {formatFinanceAmount(c.totals[metric])} USD
                      </TableCell>
                    ))}
                  </TableRow>
                )}
              </Table>
            </div>
          </>
        )}
        {view === 'summary' && (
          <>
            {report.accounts.map(a => (
              <p key={a.id}>
                {a.name} · {t('financeSpend')}: {formatFinanceAmount(a.totals.spend)} USD ·{' '}
                {t('financeTopup')}: {formatFinanceAmount(a.totals.topup)} USD
              </p>
            ))}
            {report.agents.map(a => (
              <p key={a.id}>
                {a.agentId} · {t('financeSpend')}: {formatFinanceAmount(a.totals.spend)} USD ·{' '}
                {t('financeTopup')}: {formatFinanceAmount(a.totals.topup)} USD
              </p>
            ))}
          </>
        )}
        {view === 'statement' && <FinanceTopupStatement report={report} onDay={onDay} />}
      </div>
    </section>
  );
}
