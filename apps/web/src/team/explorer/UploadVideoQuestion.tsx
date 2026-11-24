import { useEffect, useRef } from 'react';
import { Film } from 'lucide-react';
import { Alert, Button } from '../../components/ui/index';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { useI18n } from '../../i18n';
import { lastVideoChoice, type UploadVideoChoice } from './uploadVideoChoice';
import type { UploadVideoQuestion as Question } from './useExplorerUploads';

/**
 * «Оригінал чи обрізати зашивку?» — asked once for a drop with videos in it (070, owner
 * 2026-11-24), over the list the files are landing in rather than in a window over the page:
 * the drop is the context, and a dialog would take the folder away to ask about it.
 *
 * The choice made last time stands highlighted and holds the focus, so Enter repeats it; it
 * is not a rule — the next drop asks again. Esc calls the whole drop off. The two answers
 * keep their places whichever is highlighted, so the hand does not have to look for them.
 */
export function UploadVideoQuestion({ question }: { question: Question }) {
  const { t } = useI18n();
  const last = useRef<UploadVideoChoice>(lastVideoChoice()).current;
  const settled = useRef(false);
  const settle = (choice: UploadVideoChoice | null) => {
    if (settled.current) return;
    settled.current = true;
    question.settle(choice);
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;

  /* Esc wherever the focus went — a click on the list is not an answer, and the drop is
     still waiting. Heard before the folder's own Esc, which would otherwise also let go of
     the selection; a dialog or menu open over the folder keeps its Esc. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      event.preventDefault();
      settleRef.current(null);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  const answer = (
    choice: UploadVideoChoice,
    labelKey: 'teamUploadVideoOriginal' | 'teamUploadVideoTrim'
  ) => (
    <Button
      size="sm"
      color={choice === last ? 'primary' : 'neutral'}
      variant={choice === last ? 'solid' : 'outline'}
      autoFocus={choice === last}
      title={choice === 'trim' ? t('teamUploadVideoTrimHint') : undefined}
      onClick={() => settle(choice)}
    >
      {t(labelKey)}
    </Button>
  );

  return (
    <Alert
      color="info"
      className="team-upload-video-question"
      icon={<Film size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
      title={t('teamUploadVideoQuestion', { count: question.videos })}
      action={
        <div
          className="team-explorer-alert-actions"
          role="group"
          aria-label={t('teamUploadVideoQuestion', { count: question.videos })}
        >
          {answer('original', 'teamUploadVideoOriginal')}
          {answer('trim', 'teamUploadVideoTrim')}
          <Button size="sm" variant="ghost" title="" onClick={() => settle(null)}>
            {t('teamUploadVideoCancel')}
          </Button>
        </div>
      }
    />
  );
}
