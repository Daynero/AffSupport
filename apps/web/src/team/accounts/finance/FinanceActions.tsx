import { useRef, useState } from 'react';
import { ChevronDown, Copy, MoreHorizontal } from 'lucide-react';
import { Button, DropdownMenu, IconButton } from '../../../components/ui/index';
import { useI18n } from '../../../i18n';
import type { MenuEntry } from '../../../components/ui/Overlay';
import { ICON_SIZE, ICON_STROKE } from '../../../components/icons';
export function FinanceActions({
  label,
  items,
  disabled = false
}: {
  label: string;
  items: readonly MenuEntry[];
  disabled?: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton
        title=""
        ref={anchor}
        label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
      >
        <MoreHorizontal size={ICON_SIZE} strokeWidth={ICON_STROKE} />
      </IconButton>
      <DropdownMenu
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        label={label}
        items={items}
      />
    </>
  );
}

/**
 * «Копіювати» and the two ways to copy a period's top-ups (070): by social account, by tag.
 *
 * They were two buttons side by side saying almost the same words, the second one easy to take
 * for a repeat of the first. One button, the two answers in its menu.
 */
export function FinanceCopyMenu({
  disabled = false,
  onCopy
}: {
  disabled?: boolean;
  onCopy: (grouping: 'account' | 'label') => void;
}) {
  const { t } = useI18n();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        ref={anchor}
        size="sm"
        variant="soft"
        data-finance-copy="true"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        leading={<Copy size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
        trailing={<ChevronDown size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
        onClick={() => setOpen(value => !value)}
      >
        {t('financeCopyTopups')}
      </Button>
      <DropdownMenu
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        placement="bottom-end"
        label={t('financeCopyTopups')}
        items={[
          /* Under «Копіювати поповнення» the item says only how; its name says it in full. */
          {
            id: 'account',
            label: t('financeCopyByAccountShort'),
            ariaLabel: t('financeCopyByAccount'),
            onSelect: () => onCopy('account')
          },
          {
            id: 'label',
            label: t('financeCopyByLabelShort'),
            ariaLabel: t('financeCopyByLabel'),
            onSelect: () => onCopy('label')
          }
        ]}
      />
    </>
  );
}
