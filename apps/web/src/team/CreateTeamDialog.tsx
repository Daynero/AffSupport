import { useState, type FormEvent } from 'react';
import type { TeamContextSnapshot } from '../api/team';
import { useI18n } from '../i18n';
import { Modal } from '../components/Modal';
import { Button } from '../components/ui';

export function CreateTeamDialog({
  onClose,
  onCreate
}: {
  onClose: () => void;
  onCreate: (name: string) => Promise<TeamContextSnapshot>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = name.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (normalized.length < 1 || normalized.length > 120) return;
    setSubmitting(true);
    setError(null);
    try {
      await onCreate(normalized);
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message === 'NAME_CONFLICT'
          ? t('teamNameConflict')
          : t('teamLoadFailed')
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      labelledBy="create-team-title"
      onClose={onClose}
      closeLabel={t('teamCancel')}
      initialFocus="#create-team-name"
      size="sm"
    >
      <form className="team-dialog-form" onSubmit={event => void submit(event)}>
        <h2 id="create-team-title">{t('teamCreate')}</h2>
        <label>
          <span>{t('teamName')}</span>
          <input
            id="create-team-name"
            autoFocus
            value={name}
            maxLength={120}
            onChange={event => setName(event.target.value)}
          />
        </label>
        {error && <p className="team-inline-error">{error}</p>}
        <div className="team-dialog-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('teamCancel')}
          </Button>
          <Button type="submit" variant="primary" loading={submitting} disabled={!name.trim()}>
            {t('teamCreateAction')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
