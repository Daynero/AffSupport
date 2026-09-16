import { useEffect, useId, useState } from 'react';
import { PencilLine } from 'lucide-react';
import { Button, FormField, Input } from '../../components/ui/index';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { TeamApiError } from '../../api/team';
import { teamErrorMessageFor } from '../errors';
import { useTeam } from '../TeamContext';
import { SettingsSection } from './SettingsSection';

export interface SpaceNameClient {
  renameTeam: (teamId: string, name: string) => Promise<string>;
}

/**
 * The space's name, changeable (024). It could only be set once, when the space was made, so a
 * space called after a client that was lost, or a hurried "test", kept that name for good.
 */
export function SpaceNameSection({ teamId, client }: { teamId: string; client: SpaceNameClient }) {
  const { t } = useI18n();
  const { push } = useToasts();
  const { teams, replaceTeams } = useTeam();
  const titleId = useId();
  const fieldId = useId();
  const current = teams.find(team => team.id === teamId)?.name ?? '';
  const [name, setName] = useState(current);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  useEffect(() => setName(current), [current]);

  const trimmed = name.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const changed = trimmed.length > 0 && trimmed !== current;

  const save = async () => {
    if (!changed || saving) return;
    setSaving(true);
    setConflict(false);
    try {
      const saved = await client.renameTeam(teamId, trimmed);
      replaceTeams(teams.map(team => (team.id === teamId ? { ...team, name: saved } : team)));
      push({ tone: 'success', text: t('teamRenameSaved') });
    } catch (cause) {
      if (cause instanceof TeamApiError && cause.code === 'NAME_CONFLICT') setConflict(true);
      else push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      icon={PencilLine}
      titleId={titleId}
      title={t('teamRenameTitle')}
      description={t('teamRenameDescription')}
    >
      <form
        className="team-space-name-form"
        onSubmit={event => {
          event.preventDefault();
          void save();
        }}
      >
        <FormField
          label={t('teamName')}
          htmlFor={fieldId}
          error={conflict ? t('teamNameConflict') : undefined}
        >
          <Input
            id={fieldId}
            value={name}
            maxLength={120}
            invalid={conflict}
            onChange={event => {
              setName(event.target.value);
              setConflict(false);
            }}
          />
        </FormField>
        <Button type="submit" variant="secondary" loading={saving} disabled={!changed}>
          {t('teamRenameSave')}
        </Button>
      </form>
    </SettingsSection>
  );
}
