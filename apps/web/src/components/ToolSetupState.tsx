import { useState } from 'react';
import type { SotyToolId } from '@video-compressor/shared';
import { useAgent } from '../AgentContext';
import { RECONNECT_SURFACES, type ReconnectSurface } from '../analytics/events';
import type { ConnectionState } from '../connection';
import { useI18n } from '../i18n';
import type { WebTool } from '../lib/tool-registry';
import { usePageEntrance } from '../lib/navigation';
import LocalAppDialog from './LocalAppDialog';
import { ReconnectAction } from './ReconnectAction';
import { SotyMark } from './SotyLogo';
import { Button, EmptyState } from './ui/index';

/**
 * A tool opened with no Soty on this computer (070, T039, FR-029).
 *
 * The page used to be an empty `<main>` under the setup dialog, and closing
 * the dialog sent the person home — so the only answer to "why is this empty"
 * was a modal that, once dismissed, took the tool away. Now the page itself
 * says what the tool needs, in the inventory's empty state, on an opaque
 * stage as the home and account pages stand, with the download and the
 * reconnect as its actions. The dialog still opens on arrival — it carries the
 * per-platform installers and the install notes, and the state's download
 * button reopens it — but closing it leaves the person on the tool's own page.
 */
export function ToolSetupState({
  tool,
  connection
}: {
  tool: WebTool;
  connection: ConnectionState;
}) {
  const { t } = useI18n();
  const { toolAvailability } = useAgent();
  const entering = usePageEntrance();
  const [dialogOpen, setDialogOpen] = useState(true);
  // The dialog's own rule (032 FR-013): "update" only for an app that answered
  // and is too old, never for a link that dropped.
  // Only a tool that runs in the local app reaches this screen: `ToolRoute`
  // returns a browser tool (2FA) before it asks about the app at all.
  const toolId = tool.id as SotyToolId;
  const needsUpdate =
    connection === 'agent_update_required' || toolAvailability(toolId) === 'too_old';
  const name = t(tool.labelKey);
  const surface = tool.analyticsId.replace(/-/gu, '_');
  const reconnectSurface = (RECONNECT_SURFACES as readonly string[]).includes(surface)
    ? (surface as ReconnectSurface)
    : 'home';

  return (
    <>
      <main className={`page-container tool-setup-page${entering ? ' page-enter' : ''}`}>
        <EmptyState
          size="md"
          titleAs="h2"
          className="tool-setup-state"
          icon={<SotyMark size={48} />}
          title={t(needsUpdate ? 'toolNeedsSotyUpdateTitle' : 'toolNeedsSotyTitle')}
          description={t(needsUpdate ? 'toolNeedsSotyUpdateBody' : 'toolNeedsSotyBody', {
            tool: name
          })}
          action={
            <>
              {/* The download is a choice of platform with notes on installing it, and the
                  dialog is where that choice already lives; this button reopens it rather than
                  drawing a second, smaller copy of the same three installers here. */}
              <Button color="primary" onClick={() => setDialogOpen(true)}>
                {t(needsUpdate ? 'toolNeedsSotyUpdate' : 'toolNeedsSotyDownload')}
              </Button>
              {!needsUpdate && <ReconnectAction surface={reconnectSurface} size="md" />}
            </>
          }
        />
      </main>
      {dialogOpen && (
        <LocalAppDialog
          tool={toolId}
          connection={connection}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </>
  );
}
