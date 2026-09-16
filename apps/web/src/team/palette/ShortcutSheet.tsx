import { Modal } from '../../components/Modal';
import { useI18n, type TranslationKey } from '../../i18n';
import { WORKSPACE_SHORTCUTS, formatShortcut, type Shortcut } from './shortcuts';

/**
 * What the keyboard can do here, said out loud (024, FR-054).
 *
 * The workspace answered ten keystrokes and named none of them, which makes a
 * shortcut something you either already knew or never found. This reads the
 * same table the bindings read, so a line here that nothing binds — or a
 * binding with no line — is a test failure rather than a discovery somebody
 * makes eighteen months later.
 */

const SCOPE_LABEL: Record<Shortcut['scope'], TranslationKey> = {
  workspace: 'shortcutScopeWorkspace',
  explorer: 'shortcutScopeExplorer',
  task: 'shortcutScopeTask'
};

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const scopes: Array<Shortcut['scope']> = ['workspace', 'explorer', 'task'];

  return (
    <Modal
      labelledBy="workspace-shortcuts-title"
      onClose={onClose}
      closeLabel={t('teamCancel')}
      size="sm"
    >
      <div className="workspace-shortcuts">
        <h2 id="workspace-shortcuts-title">{t('shortcutSheetTitle')}</h2>
        {scopes.map(scope => {
          const rows = WORKSPACE_SHORTCUTS.filter(shortcut => shortcut.scope === scope);
          if (rows.length === 0) return null;
          return (
            <section key={scope}>
              <h3>{t(SCOPE_LABEL[scope])}</h3>
              <dl>
                {rows.map(shortcut => (
                  <div key={shortcut.id}>
                    <dt>{t(shortcut.labelKey)}</dt>
                    <dd>
                      <kbd>{formatShortcut(shortcut.keys)}</kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
    </Modal>
  );
}
