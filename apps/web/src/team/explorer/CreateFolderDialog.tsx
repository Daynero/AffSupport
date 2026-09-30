import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { Button, Input } from '../../components/ui';
import { useI18n } from '../../i18n';

export function CreateFolderDialog({
  onCreate,
  onClose
}: {
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const valid =
    name.trim().length > 0 &&
    name.trim().length <= 200 &&
    !name.split('').some(character => character.charCodeAt(0) < 32 || '/\\'.includes(character));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try {
      await onCreate(name.trim());
    } catch {
      setBusy(false);
    }
  };
  return (
    <Modal
      labelledBy="team-create-folder-title"
      size="sm"
      onClose={onClose}
      closeLabel={t('teamClose')}
    >
      <form className="team-dialog-form" onSubmit={event => void submit(event)}>
        <h3 id="team-create-folder-title">{t('teamExplorerCreateFolder')}</h3>
        <Input
          autoFocus
          aria-label={t('teamExplorerFolderName')}
          value={name}
          maxLength={200}
          disabled={busy}
          onChange={event => setName(event.target.value)}
        />
        <div className="team-dialog-actions">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t('teamCancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={!valid || busy}>
            {t('teamExplorerCreateFolder')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
