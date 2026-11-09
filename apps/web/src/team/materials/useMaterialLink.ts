import { useEffect, useRef, useState } from 'react';
import type { LibraryShareCopyResult, TeamAnalyticsStorage } from '@video-compressor/shared';
import { teamApi, TeamApiError } from '../../api/team';
import { useI18n } from '../../i18n';
import { useToasts } from '../../components/toast';
import {
  startTeamFileAttempt,
  completeTeamFileAttempt,
  teamAnalyticsSizeBucket,
  type TeamFileAttemptFlow
} from '../../analytics/service';
import {
  privateCacheActor,
  privateCacheEpoch,
  privateClientId,
  usePrivateCacheEpoch
} from '../private-cache-scope';
import { teamErrorCodeOf, teamErrorMessageFor } from '../errors';
import { withReadDeadline } from '../readCoordinator';
import {
  reportFileAttemptError,
  analyticsOutcome,
  retryableError
} from '../catalog/useMaterialActions';
import {
  beginMaterialLinkFlow,
  type MaterialLinkAction,
  type MaterialLinkFlow
} from './link-analytics';

type Mode = 'get_link' | 'share';
type Client = Pick<typeof teamApi, 'shareLibraryMaterial' | 'getLibrarySharePreference'>;
interface WriteIdentity {
  key: string;
  commandId: string;
  remember: boolean;
  version: string | null;
}
interface Owner {
  scope: string;
  epoch: number;
  actor: string | null;
  mode: Mode;
  pending: boolean;
  sequence: number;
  write: WriteIdentity | null;
  clock: { serverMs: number; monotonic: number; version: string | null } | null;
}
interface VisibleLink {
  scope: string;
  mode: Mode;
  result: LibraryShareCopyResult;
  commandId: string;
  flow: MaterialLinkFlow;
  fileAttempt: TeamFileAttemptFlow;
  goalReached: boolean;
}
/** A single per-file owner; globals fence late results before React cleanup runs. */
export function useMaterialLink(input: {
  teamId: string;
  materialId: string;
  sizeBytes?: number | null;
  storageKind: TeamAnalyticsStorage | null;
  surface: 'material' | 'catalog_manager';
  canShare: boolean;
  client?: Client;
}) {
  const epoch = usePrivateCacheEpoch();
  const client = input.client ?? teamApi;
  const scope = JSON.stringify([
    epoch,
    input.teamId,
    input.materialId,
    privateClientId(client),
    input.canShare
  ]);
  const { t } = useI18n();
  const { push } = useToasts();
  const ref = useRef<Owner | null>(null);
  const makeOwner = (): Owner => ({
    scope,
    epoch,
    actor: privateCacheActor(),
    mode: 'get_link',
    pending: false,
    sequence: 0,
    write: null,
    clock: null
  });
  if (ref.current?.scope !== scope) ref.current = makeOwner();
  const [visible, setVisible] = useState<VisibleLink | null>(null);
  const [busyScope, setBusyScope] = useState<string | null>(null);
  const [error, setError] = useState<{ scope: string; text: string } | null>(null);
  const [remember, setRemember] = useState(false);
  const current = (owner: Owner) =>
    ref.current === owner &&
    owner.epoch === privateCacheEpoch() &&
    owner.actor !== null &&
    owner.actor === privateCacheActor();
  useEffect(() => {
    if (!ref.current) ref.current = makeOwner();
    const owner = ref.current;
    return () => {
      if (ref.current === owner) ref.current = null;
    };
  }, [scope]);
  useEffect(() => {
    if (!visible || visible.scope !== scope) return;
    visible.flow.stage('url_visible');
    if (visible.goalReached) visible.flow.complete(true);
    else if (visible.result.sharing === 'uncertain')
      visible.flow.fail(
        visible.result.visibilityCode ?? 'CATALOG_LINK_SHARING_UNCERTAIN',
        'permission_unknown'
      );
    else visible.flow.complete(false);
    completeTeamFileAttempt(visible.fileAttempt, {
      outcome: visible.goalReached ? 'success' : 'blocked',
      retryable: visible.result.sharing === 'uncertain',
      delivery: 'url_visible'
    });
  }, [visible, scope]);
  const copy = async (url: string, commandId: string) => {
    const owner = ref.current;
    if (!owner || !current(owner)) return;
    const sequence = owner.sequence;
    const flow = beginMaterialLinkFlow('clipboard', { parentFlowId: commandId });
    try {
      if (!current(owner)) return;
      await navigator.clipboard.writeText(url);
      if (!current(owner) || owner.sequence !== sequence) {
        flow.cancel();
        return;
      }
      flow.stage('clipboard_copied');
      flow.complete(true);
      push({ tone: 'success', text: t('teamShareCopied') });
    } catch {
      if (!current(owner) || owner.sequence !== sequence) {
        flow.cancel();
        return;
      }
      flow.fail('CLIPBOARD_UNAVAILABLE', 'clipboard_denied');
      push({ tone: 'error', text: t('teamShareClipboardUnavailable') });
    }
  };
  const request = async (
    mode: Mode,
    action: MaterialLinkAction = 'get_link',
    approve = false,
    chosenRemember = false
  ) => {
    const owner = ref.current;
    if (!owner || !current(owner) || owner.pending) return;
    const shareGoal = mode === 'share' || owner.write !== null;
    owner.mode = shareGoal ? 'share' : mode;
    owner.pending = true;
    const sequence = ++owner.sequence;
    setBusyScope(scope);
    setError(null);
    const attempt = startTeamFileAttempt({
      action: 'share',
      surface: input.surface,
      storageKind: input.storageKind ?? 'unknown',
      sizeBucket: teamAnalyticsSizeBucket(input.sizeBytes)
    });
    const attemptId = attempt.attemptId;
    const parentFlowId =
      owner.write?.commandId ??
      ((action === 'confirm' || action === 'readback') && visible?.scope === scope
        ? visible.commandId
        : undefined);
    const flow = beginMaterialLinkFlow(action, {
      attemptId,
      ...(parentFlowId ? { parentFlowId } : {})
    });
    try {
      let key = `link.read.${attemptId}`;
      let remembered = chosenRemember;
      if (approve) {
        if (!owner.clock) throw new TeamApiError('CATALOG_LINK_UPDATE_REQUIRED', false);
        if (Math.max(0, performance.now() - owner.clock.monotonic) > 5 * 60_000)
          throw new TeamApiError('CATALOG_LINK_REQUEST_EXPIRED', false);
        if (!owner.write) {
          const issued = Math.floor(owner.clock.serverMs);
          owner.write = {
            key: `share.v2:${issued}:${flow.commandId}`,
            commandId: flow.commandId,
            remember: chosenRemember,
            version: owner.clock.version
          };
        }
        key = owner.write.key;
        remembered = owner.write.remember;
        flow.stage('permission_requested');
      }
      let result = await client.shareLibraryMaterial({
        teamId: input.teamId,
        materialId: input.materialId,
        expectedActorId: owner.actor!,
        allowIfRestricted: approve,
        rememberChoice: approve && remembered,
        idempotencyKey: key,
        ...(approve ? { expectedShareVersion: owner.write!.version } : {})
      });
      if (!current(owner) || owner.sequence !== sequence) {
        flow.cancel();
        completeTeamFileAttempt(attempt, { outcome: 'cancelled', retryable: false });
        return;
      }
      if (
        !approve &&
        action === 'share' &&
        input.canShare &&
        result.public === false &&
        result.canShare &&
        result.sharing !== 'uncertain' &&
        result.linkProtocol === 2 &&
        result.serverNow &&
        result.shareVersion !== undefined
      ) {
        owner.clock = {
          serverMs: Date.parse(result.serverNow),
          monotonic: performance.now(),
          version: result.shareVersion
        };
        let allowed = false;
        try {
          const preference = await withReadDeadline(
            () => client.getLibrarySharePreference(input.teamId),
            new AbortController().signal
          );
          allowed = preference.remembered && preference.allowLinkOnCopy;
          flow.stage('preference_checked');
        } catch (cause) {
          flow.stage('preference_unknown', teamErrorCodeOf(cause) ?? 'DRIVE_UNAVAILABLE');
        }
        if (!current(owner) || owner.sequence !== sequence) {
          flow.cancel();
          completeTeamFileAttempt(attempt, { outcome: 'cancelled', retryable: false });
          return;
        }
        if (allowed) {
          approve = true;
          const issued = Math.floor(owner.clock.serverMs);
          owner.write = {
            key: `share.v2:${issued}:${flow.commandId}`,
            commandId: flow.commandId,
            remember: false,
            version: owner.clock.version
          };
          flow.stage('permission_requested');
          result = await client.shareLibraryMaterial({
            teamId: input.teamId,
            materialId: input.materialId,
            expectedActorId: owner.actor!,
            allowIfRestricted: true,
            rememberChoice: false,
            expectedShareVersion: owner.write.version,
            idempotencyKey: owner.write.key
          });
          if (!current(owner) || owner.sequence !== sequence) {
            flow.cancel();
            completeTeamFileAttempt(attempt, { outcome: 'cancelled', retryable: false });
            return;
          }
        }
      }
      if (result.linkProtocol === 2 && result.serverNow && result.shareVersion !== undefined)
        owner.clock = {
          serverMs: Date.parse(result.serverNow),
          monotonic: performance.now(),
          version: result.shareVersion
        };
      if (result.pendingCommandId) flow.relateParent(result.pendingCommandId);
      flow.stage('url_verified');
      flow.stage(
        result.public === null ? 'visibility_unknown' : 'visibility_verified',
        result.visibilityCode
      );
      if (result.sharing === 'uncertain') flow.stage('permission_unknown', result.visibilityCode);
      else if (shareGoal && result.public === true) flow.stage('permission_verified');
      if (result.preferenceSaved === true) flow.stage('preference_saved');
      if (result.preferenceSaved === false) flow.stage('preference_failed', result.preferenceCode);
      if (result.state === 'confirmation_required') flow.stage('confirmation_required');
      if (owner.write && result.public !== null && result.sharing !== 'uncertain')
        owner.write = null;
      const goalReached = !shareGoal || result.public === true;
      setVisible({
        scope,
        mode,
        result,
        commandId: flow.commandId,
        flow,
        fileAttempt: attempt,
        goalReached
      });
      if (result.preferenceSaved === false)
        push({ tone: 'error', text: t('materialLinkPreferenceFailed') });
      // The selectable URL is committed independently of clipboard permission.
      void copy(result.url, flow.commandId);
    } catch (cause) {
      if (!current(owner) || owner.sequence !== sequence) {
        flow.cancel();
        completeTeamFileAttempt(attempt, { outcome: 'cancelled', retryable: false });
        return;
      }
      const code = teamErrorCodeOf(cause) ?? 'DRIVE_UNAVAILABLE';
      flow.fail(code, approve ? 'permission_requested' : 'requested');
      completeTeamFileAttempt(attempt, {
        outcome: analyticsOutcome(cause),
        retryable: retryableError(cause)
      });
      try {
        reportFileAttemptError(attempt, cause);
      } catch {
        /* Diagnostics cannot hide recovery. */
      }
      if (
        [
          'INVALID_INPUT',
          'PERMISSION_DENIED',
          'AUTH_REQUIRED',
          'CATALOG_LINK_REQUEST_EXPIRED'
        ].includes(code)
      )
        owner.write = null;
      setError({ scope, text: teamErrorMessageFor(cause, t) });
      push({ tone: 'error', text: teamErrorMessageFor(cause, t) });
    } finally {
      owner.pending = false;
      if (current(owner)) setBusyScope(null);
    }
  };
  const open = async (mode: Mode) => {
    const owner = ref.current;
    if (!owner || !current(owner) || owner.pending) return;
    setRemember(false);
    // Recover a retained write by reading only, never by repeating its POST.
    await request(mode, owner.write ? 'readback' : mode);
  };
  const approve = () => {
    const owner = ref.current;
    const shown = visible?.scope === scope ? visible : null;
    if (
      !owner ||
      !shown ||
      !input.canShare ||
      !current(owner) ||
      owner.pending ||
      owner.write ||
      shown.result.sharing === 'uncertain'
    )
      return;
    if (shown.result.linkProtocol !== 2) {
      setError({ scope, text: t('materialLinkUpdateRequired') });
      return;
    }
    return request('share', 'confirm', true, remember);
  };
  const check = () =>
    request(
      visible?.scope === scope ? visible.mode : (ref.current?.mode ?? 'get_link'),
      'readback'
    );
  return {
    visible: visible?.scope === scope ? visible : null,
    busy: busyScope === scope,
    awaitingConfirmation: Boolean(ref.current?.write),
    error: error?.scope === scope ? error.text : null,
    remember,
    setRemember,
    open,
    approve,
    check,
    copy: () => {
      if (visible?.scope === scope) void copy(visible.result.url, visible.commandId);
    },
    openUrl: () => {
      const owner = ref.current;
      if (owner && current(owner) && visible?.scope === scope)
        window.open(visible.result.url, '_blank', 'noopener,noreferrer');
    },
    dismiss: () => {
      const owner = ref.current;
      if (owner) owner.sequence++;
      setBusyScope(null);
      setVisible(null);
      setError(null);
    }
  };
}
