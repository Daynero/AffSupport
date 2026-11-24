import { useRef, useState, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { Button, Popover } from '../../components/ui/index';

/**
 * «Фільтри» and the panel it opens (024; one component since 070, T079/T080).
 *
 * The board and the launch list each drew this chip by hand, the same raw button twice. It says
 * how many filters are on before the panel is opened — a count beside the word, and the chip lit
 * the way the date chip is once it narrows the list. On a phone the word folds away and the
 * glyph with its count is the chip; the name stays for a reader either way.
 */
export function TaskFiltersButton({ count, children }: { count: number; children: ReactNode }) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const name = count > 0 ? t('teamTasksMoreFiltersActive', { count }) : t('teamTasksMoreFilters');
  return (
    <div ref={root} className="task-filter-more">
      <Button
        {...(count > 0 ? ({ variant: 'soft', color: 'secondary' } as const) : { variant: 'ghost' })}
        className="task-filter-more-trigger"
        aria-expanded={open}
        aria-label={name}
        title={name}
        leading={<SlidersHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
        trailing={count > 0 ? <span className="task-filter-more-count">{count}</span> : undefined}
        onClick={() => setOpen(current => !current)}
      >
        <span className="task-filter-more-word">{t('teamTasksMoreFilters')}</span>
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={root}
        placement="bottom-start"
        frequent
        label={t('teamTasksMoreFilters')}
        className="task-filter-more-popover"
      >
        {children}
      </Popover>
    </div>
  );
}
