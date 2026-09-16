import { useEffect, useRef } from 'react';
import { Button } from '../../components/ui/index';
import { useI18n } from '../../i18n';

/**
 * The next page, fetched because you reached the end of this one (024, FR-044).
 *
 * A folder of five hundred arrived a hundred at a time behind a button, so
 * getting to the bottom of one meant pressing "Show more" four times — and the
 * search, the arrow keys and the batch scope all worked on whatever happened
 * to have been pressed into existence. Five presses is not a page size; it is
 * a page size that somebody forgot to finish.
 *
 * The button stays. It is what the observer falls back to where there is no
 * observer, it is what a keyboard reaches, and it is the honest thing to show
 * while a fetch is in flight: a sentinel that silently does nothing is
 * indistinguishable from a list that has ended.
 *
 * Deliberately not virtualised. Five hundred rows of plain markup is not what
 * makes this screen slow — the hundred-at-a-time fetching was — and windowing
 * costs the browser's own find-on-page, which is how people actually look for
 * a file in a long list.
 */
export function MorePages({
  hasMore,
  loading,
  onLoadMore
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const { t } = useI18n();
  const sentinel = useRef<HTMLDivElement | null>(null);
  const load = useRef(onLoadMore);
  load.current = onLoadMore;
  const busy = useRef(false);
  busy.current = loading;

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(entry => entry.isIntersecting) || busy.current) return;
        load.current();
      },
      // A screen's worth of warning, so the next hundred are usually there
      // before the scroll reaches them.
      { rootMargin: '600px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore]);

  if (!hasMore) return null;
  return (
    <div className="team-explorer-more" ref={sentinel}>
      <Button color="neutral" variant="outline" loading={loading} onClick={onLoadMore}>
        {t('teamExplorerLoadMore')}
      </Button>
    </div>
  );
}
