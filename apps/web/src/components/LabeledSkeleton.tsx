import { useI18n, type TranslationKey } from '../i18n';
import { Skeleton } from './ui/index';

/**
 * A loading placeholder that says what it is loading.
 *
 * The contract bans a bare "…" (contracts/ui-conventions.md): an ellipsis on
 * its own is indistinguishable from a stuck screen, an empty list, and a failed
 * request. The caption is the accessible text; the shimmering bars are
 * decoration and are hidden from the accessibility tree.
 */
export function LabeledSkeleton({
  label,
  rows = 3
}: {
  label: TranslationKey;
  /** How many placeholder bars to draw. Purely visual. */
  rows?: number;
}) {
  const { t } = useI18n();
  return (
    <div className="ui-skeleton-list">
      {/* The caption stays visible rather than becoming screen-reader-only:
          this product's loads can take a while, and a shimmering bar with no
          words is indistinguishable from a stuck screen. */}
      <p className="ui-skeleton-label" aria-live="polite">
        {t(label)}
      </p>
      <Skeleton shape="row" count={rows} />
    </div>
  );
}
