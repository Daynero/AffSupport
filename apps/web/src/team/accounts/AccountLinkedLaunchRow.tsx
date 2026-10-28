import { useRef, useState } from 'react';
import { Check, Pencil, Trash2 } from 'lucide-react';
import type {
  LaunchAssignmentReceipt,
  TeamAccountLaunchAssignment
} from '@video-compressor/shared';
import { IconButton } from '../../components/ui';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
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
  canAssign = canEdit,
  onChanged,
  canMutate
}: {
  teamId: string;
  launch: TeamAccountLaunchAssignment;
  canEdit: boolean;
  canAssign?: boolean;
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
  return (
    <div
      className="team-agent-run account-linked-launch-row"
      data-launch-assignment-id={launch.id}
      aria-busy={busy}
    >
      <a
        className="team-agent-run-text account-linked-launch"
        href={href}
        onClick={event => internalLink(event, href)}
        title={title}
      >
        {title}
      </a>
      {launch.assignmentState === 'legacy_unknown' ? (
        <span className="team-agent-run-age">{t('teamAgentAvailabilityUnknown')}</span>
      ) : (
        <span aria-hidden="true" />
      )}
      {canEdit && (
        <span className="team-agent-run-actions">
          {launch.assignmentState === 'legacy_unknown' && (
            <IconButton
              label={`${t('launchesAssignmentAssign')}: ${title}`}
              className="team-agent-action is-small"
              disabled={busy || uncertain || !canAssign}
              onClick={() => void change(launch.agentRowId)}
            >
              <Check size={ICON_SIZE} strokeWidth={ICON_STROKE} />
            </IconButton>
          )}
          <IconButton
            label={`${t('launchesAssignmentEdit')}: ${title}`}
            className="team-agent-action is-small"
            disabled={busy}
            onClick={() => {
              navigateTo(href);
            }}
          >
            <Pencil size={ICON_SIZE} strokeWidth={ICON_STROKE} />
          </IconButton>
          <IconButton
            label={`${t(uncertain ? (retryAllowed ? 'retry' : 'launchesAssignmentCheck') : launch.assignmentState === 'legacy_unknown' ? 'launchesAssignmentHistoryOnly' : 'launchesAssignmentRelease')}: ${title}`}
            className="team-agent-action is-small is-danger"
            disabled={busy}
            title={t('launchesAssignmentProcessing')}
            onClick={() =>
              void change(null, launch.assignmentVersion, false, uncertain && !retryAllowed)
            }
          >
            <Trash2 size={ICON_SIZE} strokeWidth={ICON_STROKE} />
          </IconButton>
        </span>
      )}
    </div>
  );
}
