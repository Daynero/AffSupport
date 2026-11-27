import { useState, type FormEvent, type ReactNode } from 'react';
import type { TeamContextSnapshot } from '../../api/team';
import { TeamApiError } from '../../api/team';
import { useI18n } from '../../i18n';
import { Button, Card, ErrorState, FormField, Input } from '../../components/ui/index';

/**
 * Wizard step 1: the required space name. Reuses the existing team-name
 * normalization/length rule. On continue it creates the team (the folder step
 * needs a team id) and hands the id up; a name conflict keeps the user here.
 */
export function SpaceNameStep({
  createTeam,
  onCreated,
  onCancel,
  initialName = '',
  hint,
  children
}: {
  createTeam: (name: string) => Promise<TeamContextSnapshot>;
  onCreated: (team: TeamContextSnapshot) => void;
  onCancel: () => void;
  /** What was typed before stepping forward, restored when stepping back. */
  initialName?: string;
  /** In place of the Drive wording, when the space will not take a folder's name (057). */
  hint?: string;
  /** Drawn under the name: the storage choice a pilot gets (057). */
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initialName);
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
      const code =
        cause instanceof TeamApiError ? cause.code : cause instanceof Error ? cause.message : null;
      setError(
        code === 'NAME_CONFLICT'
          ? t('teamNameConflict')
          : code === 'PERMISSION_DENIED'
            ? t('teamSpaceSaveDenied')
            : code === 'R2_PILOT_REQUIRED'
              ? t('spaceStorageErrorPilotRequired')
              : code === 'CLIENT_UPDATE_REQUIRED'
                ? t('spaceStorageErrorClientUpdate')
                : t('teamLoadFailed')
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card
      as="form"
      className="team-create-step"
      title={t('teamCreateStepNameTitle')}
      description={hint ?? t('teamCreateStepNameHint')}
      onSubmit={event => void submit(event)}
    >
      <FormField label={t('teamName')} htmlFor="create-space-name" required>
        <Input
          id="create-space-name"
          autoFocus
          value={name}
          // The suggestion is selected, so typing replaces it and Enter keeps it.
          onFocus={event => event.currentTarget.select()}
          maxLength={120}
          invalid={Boolean(error)}
          onChange={event => setName(event.target.value)}
        />
      </FormField>
      {children}
      {error && <ErrorState className="team-inline-error" message={error} />}
      <div className="team-create-actions">
        <Button color="neutral" variant="ghost" onClick={onCancel}>
          {t('teamCancel')}
        </Button>
        <Button
          type="submit"
          color="primary"
          variant="solid"
          loading={submitting}
          disabled={!name.trim()}
        >
          {t('teamCreateContinue')}
        </Button>
      </div>
    </Card>
  );
}
