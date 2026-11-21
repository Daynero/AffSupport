import { useLayoutEffect, useRef, useState } from 'react';

/**
 * The automatic budgets beside «До», as many as the line holds.
 *
 * It showed four and folded the rest into «+N» however much room was left — six
 * campaigns read «10$ 14$ 18$ 22$ +2» with half the row empty (next QA 2026-11-21).
 * Now every budget that fits is shown, and «+N» stands only for the ones that do
 * not, with their values in its title. The widths come from an invisible copy of the
 * whole set, measured again whenever the line changes width.
 */
export function LaunchBudgetPreview({
  budgets,
  label,
  moreLabel
}: {
  budgets: readonly number[];
  label: string;
  moreLabel: (count: number) => string;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const line = useRef<HTMLOutputElement>(null);
  const ruler = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(budgets.length);
  const signature = budgets.join(',');

  useLayoutEffect(() => {
    const node = box.current;
    const measure = ruler.current;
    const output = line.current;
    if (!node || !measure || !output) return;
    const fit = () => {
      const available = node.clientWidth;
      const widths = Array.from(
        measure.querySelectorAll<HTMLElement>('[data-budget]'),
        item => item.offsetWidth
      );
      const badge = measure.querySelector<HTMLElement>('[data-more]')?.offsetWidth ?? 0;
      const gap = Number.parseFloat(getComputedStyle(output).columnGap) || 0;
      let used = 0;
      let count = 0;
      for (const [index, width] of widths.entries()) {
        const next = used + (count > 0 ? gap : 0) + width;
        const rest = widths.length - index - 1;
        if ((rest > 0 ? next + gap + badge : next) > available) break;
        used = next;
        count += 1;
      }
      setShown(count);
    };
    fit();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [signature]);

  const visible = Math.min(shown, budgets.length);
  const hidden = budgets.slice(visible);
  return (
    <span ref={box} className="launch-editor-budget-fit">
      <output ref={line} className="launch-editor-budget-preview" aria-label={label}>
        {budgets.slice(0, visible).map((budget, index) => (
          <span key={index}>
            {budget} <span className="launch-editor-budget-currency">$</span>
          </span>
        ))}
        {hidden.length > 0 && (
          <span aria-label={moreLabel(hidden.length)} title={hidden.map(b => `${b}$`).join(' · ')}>
            +{hidden.length}
          </span>
        )}
      </output>
      {/* Beside the output, not in it: its text must stay the budgets alone. */}
      <span ref={ruler} className="launch-editor-budget-ruler" aria-hidden="true">
        {budgets.map((budget, index) => (
          <span key={index} data-budget="">
            {budget} <span className="launch-editor-budget-currency">$</span>
          </span>
        ))}
        <span data-more="">+{budgets.length}</span>
      </span>
    </span>
  );
}
