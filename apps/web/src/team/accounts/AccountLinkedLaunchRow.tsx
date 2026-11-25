import { useRef, useState } from 'react';
import { Pencil, Rocket, Unlink } from 'lucide-react';
import type {
  LaunchAssignmentReceipt,
  TeamAccountLaunchAssignment
} from '@video-compressor/shared';
import { IconButton } from '../../components/ui/index';
import { ICON_STROKE } from '../../components/icons';

const ICON_SMALL = 16;
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { internalLink, navigateTo } from '../../lib/navigation';
import { buildTeamRoute } from '../routes';
import { teamErrorMessageFor } from '../errors';
import { TeamApiError } from '../../api/team';
import { launchMutation } from '../launches/analytics';
import {
  launchAssignmentsApi,
  isDefinitiveAssignmentError,
  type SetLaunchAssignment
} from '../../api/team-launch-assignments';

type AssignmentAction = 'assign_account' | 'release_account';
export function AccountLinkedLaunchRow({
  teamId,
  launch,
  canEdit,
  onChanged,
  canMutate
}: {
  teamId: string;
  launch: TeamAccountLaunchAssignment;
  canEdit: boolean;
  canMutate?: () => boolean;
  onChanged: (
    receipt: LaunchAssignmentReceipt,
    flowId: string,
    action: AssignmentAction
  ) => Promise<void>;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [retryAllowed, setRetryAllowed] = useState(false);
  const livePermission = useRef(canEdit);
  livePermission.current = canEdit;
  const activeMutation = useRef(false);
  const pending = useRef<{ input: SetLaunchAssignment; flowId: string } | null>(null);
  const href = buildTeamRoute({
    spaceId: teamId,
    section: 'launches',
    query: { launchId: launch.id }
  });
  const title = `${launch.creativeAlias || t('launchesTitle')} · ${launch.launchDate ?? launch.workStatus}`;
  const change = async (
    agentRowId: string | null,
    version = launch.assignmentVersion,
    undo = false,
    checkOnly = false
  ) => {
    if (activeMutation.current) return;
    if (!(canMutate ? canMutate() : livePermission.current)) {
      push({
        tone: 'error',
        text: teamErrorMessageFor(new TeamApiError('PERMISSION_DENIED', false), t)
      });
      return;
    }
    const intent = pending.current ?? {
      input: {
        teamId,
        launchId: launch.id,
        agentRowId,
        expectedVersion: version,
        requestKey: crypto.randomUUID()
      },
      flowId: crypto.randomUUID()
    };
    pending.current = intent;
    const action = intent.input.agentRowId ? 'assign_account' : 'release_account';
    setBusy(true);
    activeMutation.current = true;
    try {
      const recovered = checkOnly
        ? await launchAssignmentsApi.readMutation(teamId, intent.input.requestKey)
        : null;
      if (checkOnly && !recovered) {
        setRetryAllowed(true);
        setUncertain(true);
        return;
      }
      if (
        recovered &&
        (recovered.launchId !== intent.input.launchId ||
          recovered.agentRowId !== intent.input.agentRowId ||
          recovered.requestKey !== intent.input.requestKey)
      )
        throw new Error('INVALID_RESPONSE');
      const receipt =
        recovered ??
        (await launchMutation({ flowId: intent.flowId, launchId: launch.id }, action, () =>
          launchAssignmentsApi.set(intent.input)
        ));
      await onChanged(receipt, intent.flowId, action);
      pending.current = null;
      setUncertain(false);
      setRetryAllowed(false);
      push({
        tone: 'success',
        text: t(receipt.agentRowId ? 'launchesAssignmentConfirmed' : 'launchesAssignmentDetached'),
        ...(!receipt.agentRowId && launch.assignmentState === 'assigned' && !undo
          ? {
              action: {
                label: t('teamUndo'),
                run: () => change(launch.agentRowId, receipt.version, true)
              }
            }
          : {})
      });
    } catch (error) {
      const unknown = !isDefinitiveAssignmentError(error);
      if (!unknown) pending.current = null;
      setUncertain(unknown);
      push({
        tone: unknown ? 'warning' : 'error',
        text: unknown ? t('launchesAssignmentUnknown') : teamErrorMessageFor(error, t),
        sticky: unknown
      });
    } finally {
      activeMutation.current = false;
      setBusy(false);
    }
  };
  /*
   * A launch held on the agent reads as one: a rocket where a note has its colour dot, and the
   * launch's name as a link to it (owner, beta 25.11 — the hand-written notes under it were taken
   * for launches). A link carried over from before assignments were recorded is the same link:
   * the agent is busy or free, never "unconfirmed", so nothing is asked of it here.
   */
  return (
    <div
      className="team-agent-run account-linked-launch-row"
      data-launch-assignment-id={launch.id}
      aria-busy={busy}
    >
      <span className="team-agent-run-kind" aria-hidden="true">
        <Rocket size={ICON_SMALL} strokeWidth={ICON_STROKE} />
      </span>
      <a
        className="team-agent-run-text account-linked-launch"
        href={href}
        onClick={event => internalLink(event, href)}
        title={`${t('launchesTitle')}: ${title}`}
      >
        {title}
      </a>
      {canEdit && (
        <span className="team-agent-run-actions">
          <IconButton
            size="xs"
            label={`${t('launchesAssignmentEdit')}: ${title}`}
            title={t('launchesAssignmentEdit')}
            className="team-agent-action is-small"
            disabled={busy}
            onClick={() => {
              navigateTo(href);
            }}
          >
            <Pencil size={ICON_SMALL} strokeWidth={ICON_STROKE} />
          </IconButton>
          <IconButton
            size="xs"
            label={`${t(uncertain ? (retryAllowed ? 'retry' : 'launchesAssignmentCheck') : 'launchesAssignmentRelease')}: ${title}`}
            className="team-agent-action is-small is-danger"
            disabled={busy}
            title={`${t('launchesAssignmentRelease')} · ${t('launchesAssignmentProcessing')}`}
            onClick={() =>
              void change(null, launch.assignmentVersion, false, uncertain && !retryAllowed)
            }
          >
            <Unlink size={ICON_SMALL} strokeWidth={ICON_STROKE} />
          </IconButton>
        </span>
      )}
    </div>
  );
}
