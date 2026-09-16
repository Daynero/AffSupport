import { Check } from 'lucide-react';
import { IconButton } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { MaterialActionMenu } from './MaterialActionMenu';
import type { MaterialActionId } from './actions';
import type { MaterialActionList } from './useMaterialActionList';

/**
 * The two or three things this surface is for, and one door to the rest.
 *
 * The rule the tile broke: past four icons nobody reads them. Which ones are
 * inline is not this component's decision and not the surface's either — it is
 * `inlinePriority` in the registry, so the same action is inline in the same
 * places, and the reader learns one layout rather than five.
 */
export function MaterialInlineActions({
  list,
  name,
  busy,
  done,
  size = 'sm',
  className
}: {
  list: MaterialActionList;
  /** The material's name, for "Actions on <name>". */
  name: string;
  /** The action this surface is running right now, if any. */
  busy?: MaterialActionId | null;
  /**
   * The action that has just succeeded, held for a moment.
   *
   * Copying a link is the one action whose result is invisible — nothing opens,
   * nothing moves — so the control says so itself rather than raising a toast
   * for something the reader asked for and expected.
   */
  done?: MaterialActionId | null;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}) {
  const { t } = useI18n();
  if (list.count === 0) return null;

  // Everything inline is also in the menu. A shortcut that removes its own
  // long way round is a shortcut that has to be found before it can be used.
  const hasMore = list.count > list.inline.length;

  return (
    <div className={['ui-material-actions', className].filter(Boolean).join(' ')}>
      {list.inline.map(({ action, run }) => {
        const succeeded = done === action.id;
        const Icon = succeeded ? Check : action.icon;
        return (
          <IconButton
            key={action.id}
            label={t(action.labelKey)}
            size={size}
            variant="ghost"
            color={succeeded ? 'success' : action.destructive ? 'error' : 'neutral'}
            loading={busy === action.id}
            onClick={run}
          >
            <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        );
      })}
      {hasMore && (
        <MaterialActionMenu list={list} label={t('materialActionsFor', { name })} size={size} />
      )}
    </div>
  );
}
