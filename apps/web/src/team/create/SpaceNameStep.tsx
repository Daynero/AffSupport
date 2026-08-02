import { useState, type FormEvent } from 'react';
import type { TeamContextSnapshot } from '../../api/team';
import { TeamApiError } from '../../api/team';
import { Button } from '../../components/ui';
import { useI18n } from '../../i18n';

/**
 * Wizard step 1: the required space name. Reuses the existing team-name
 * normalization/length rule. On continue it creates the team (the folder step
 * needs a team id) and hands the id up; a name conflict keeps the user here.
 */
export function SpaceNameStep({
  createTeam,
  onCreated,
  onCancel
}: {
  createTeam: (name: string) => Promise<TeamContextSnapshot>;
  onCreated: (team: TeamContextSnapshot) => void;
  onCancel: () => void;
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
      const created = await createTeam(normalized);
      onCreated(created);
    } catch (cause) {
      setError(
        cause instanceof TeamApiError && cause.code === 'NAME_CONFLICT'
          ? t('teamNameConflict')
          : cause instanceof Error && cause.message === 'NAME_CONFLICT'
            ? t('teamNameConflict')
            : t('teamLoadFailed')
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="team-create-step" onSubmit={event => void submit(event)}>
      <div className="team-create-step-copy">
        <h2>{t('teamCreateStepNameTitle')}</h2>
        <p>{t('teamCreateStepNameHint')}</p>
      </div>
      <label className="team-create-field">
        <span>{t('teamName')}</span>
        <input
          id="create-space-name"
          autoFocus
          value={name}
          maxLength={120}
          onChange={event => setName(event.target.value)}
        />
      </label>
      {error && <p className="team-inline-error">{error}</p>}
      <div className="team-create-actions">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('teamCreateCancel')}
        </Button>
        <Button type="submit" variant="primary" loading={submitting} disabled={!name.trim()}>
          {t('teamCreateContinue')}
        </Button>
      </div>
    </form>
  );
}
