/**
 * What to do about a file whose name the folder already has.
 *
 * A drop used to answer this by itself — silently keeping both under a
 * "(2)" — or, when the catalogue and the drive disagreed, by refusing with
 * "that name is taken". Neither is the person's decision to lose: the same
 * name usually means a newer cut of the same thing, and replacing it is what
 * they came to do.
 *
 * "Replace" is a new version of the material that is already there, not an
 * overwrite: the file keeps its place, its tags and its history, and the
 * previous cut stays reachable.
 */

import { useState } from 'react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';

export type UploadConflictChoice = 'replace' | 'keep_both' | 'skip';

export interface UploadConflictRequest {
  fileName: string;
  /** The material already carrying that name; the replace target. */
  existingMaterialId: string;
  /** How many files of this drop are still waiting behind this one. */
  remaining: number;
}

export function UploadConflictDialog({
  request,
  onChoose
}: {
  request: UploadConflictRequest;
  onChoose: (choice: UploadConflictChoice, forRest: boolean) => void;
}) {
  const { t } = useI18n();
  const [forRest, setForRest] = useState(false);
  const titleId = 'team-upload-conflict-title';

  return (
    <Modal
      labelledBy={titleId}
      size="sm"
      onClose={() => onChoose('skip', false)}
      closeLabel={t('teamClose')}
    >
      <h3 id={titleId}>{t('teamUploadConflictTitle', { name: request.fileName })}</h3>
      <p>{t('teamUploadConflictBody')}</p>
      {/* Only when there is a rest to apply it to. */}
      {request.remaining > 0 && (
        <label className="team-upload-conflict-rest">
          <input
            type="checkbox"
            checked={forRest}
            onChange={event => setForRest(event.target.checked)}
          />
          <span>{t('teamUploadConflictForRest', { count: request.remaining })}</span>
        </label>
      )}
      <div className="team-dialog-actions">
        <Button type="button" variant="primary" onClick={() => onChoose('replace', forRest)}>
          {t('teamUploadConflictReplace')}
        </Button>
        <Button type="button" variant="secondary" onClick={() => onChoose('keep_both', forRest)}>
          {t('teamUploadConflictKeepBoth')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => onChoose('skip', forRest)}>
          {t('teamUploadConflictSkip')}
        </Button>
      </div>
    </Modal>
  );
}
