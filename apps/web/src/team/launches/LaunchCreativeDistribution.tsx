import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import {
  balanceCopies,
  dragCopies,
  evenCopies,
  maxCopiesFor,
  setCopies,
  type LaunchCreative
} from '@video-compressor/shared';
import { Accordion, Button, Input, Slider } from '../../components/ui/index.js';
import { useI18n } from '../../i18n.js';

const SUMMARY_VALUES = 6;
const PAGE_STEP = 10;

/**
 * 062: how the catalog's products are shared between its creatives. Collapsed by
 * default with the split in its header; a slider re-shares everyone, a typed
 * number holds while the untyped shares compensate, and "Even" resets.
 */
export function LaunchCreativeDistribution({
  creatives,
  productCount,
  disabled,
  invalid = false,
  onChange
}: {
  creatives: LaunchCreative[];
  productCount: number;
  disabled: boolean;
  /** An error inside (e.g. a share that cannot add up) opens the panel. */
  invalid?: boolean;
  onChange: (creatives: LaunchCreative[]) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (invalid) setOpen(true);
  }, [invalid]);
  if (creatives.length < 2) return null;
  const n = productCount;
  const k = creatives.length;
  const max = maxCopiesFor(n, k);
  const values = creatives.map(creative => creative.copies);
  const even = evenCopies(n, k);
  const isEven = values.every((value, index) => value === even[index]);
  const summary = values.slice(0, SUMMARY_VALUES).join(' · ') + (k > SUMMARY_VALUES ? ' · …' : '');
  const pageKeys = (index: number) => (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'PageUp' && event.key !== 'PageDown') return;
    event.preventDefault();
    const delta = event.key === 'PageUp' ? PAGE_STEP : -PAGE_STEP;
    onChange(dragCopies(creatives, index, creatives[index]!.copies + delta, n));
  };
  return (
    <Accordion
      className="min-w-0 basis-full"
      openIds={open ? new Set([`${id}-split`]) : new Set()}
      onToggle={() => setOpen(value => !value)}
      items={[
        {
          id: `${id}-split`,
          title: t('launchDistributionTitle'),
          aside: <span title={values.join(' · ')}>{summary}</span>,
          content: (
            <div className="flex min-w-0 max-w-2xl flex-col gap-3 py-3">
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled || isEven}
                  onClick={() => onChange(balanceCopies(creatives, n))}
                >
                  {t('launchDistributionBalance')}
                </Button>
              </div>
              <ul className="m-0 flex max-h-96 list-none flex-col gap-3 overflow-y-auto p-0">
                {creatives.map((creative, index) => {
                  const label = t('launchDistributionCopiesFor', { name: creative.alias });
                  return (
                    <li key={creative.materialId} className="flex min-w-0 items-center gap-3">
                      <span className="w-40 min-w-0 shrink-0 truncate" title={creative.alias}>
                        {creative.alias}
                      </span>
                      <Slider
                        className="min-w-0 flex-1"
                        aria-label={label}
                        min={1}
                        max={max}
                        step={1}
                        value={creative.copies}
                        disabled={disabled || max <= 1}
                        onKeyDown={pageKeys(index)}
                        onChange={value => onChange(dragCopies(creatives, index, value, n))}
                      />
                      <Input
                        aria-label={label}
                        type="number"
                        width="narrow"
                        min={1}
                        max={max}
                        value={creative.copies}
                        disabled={disabled}
                        onChange={event => {
                          const value = Number(event.target.value);
                          if (Number.isFinite(value) && value >= 1)
                            onChange(setCopies(creatives, index, value, n));
                        }}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          )
        }
      ]}
    />
  );
}
