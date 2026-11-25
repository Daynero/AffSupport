import { useEffect, useState } from 'react';
import type { TeamBaseRole } from '@video-compressor/shared';
import type { SpaceRemovalPreview, TeamContextSnapshot, TeamMemberSummary } from '../../api/team';
import { Button, ConfirmDialog, ErrorState, LoadingState, Modal } from '../../components/ui/index';
import { useToasts } from '../../components/toast';
import { useI18n, type TranslationKey } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { OwnershipTransferDialog } from '../members/OwnershipTransferDialog';

export interface SpaceRemovalClient {
  getSpaceRemovalPreview: (
    teamId: string,
    options?: { signal?: AbortSignal }
  ) => Promise<SpaceRemovalPreview>;
  deleteSpace: (teamId: string) => Promise<true>;
  leaveTeam: (teamId: string) => Promise<{ ok: true; warningCode: string }>;
  listMembers: (teamId: string, options?: { signal?: AbortSignal }) => Promise<TeamMemberSummary[]>;
  transferOwnership: (input: {
    teamId: string;
    toUserId: string;
    demoteTo: TeamBaseRole;
  }) => Promise<unknown>;
}

/** What the confirmation lists as going with the space, in the order a person thinks of it. */
const GOES: ReadonlyArray<[keyof SpaceRemovalPreview, TranslationKey]> = [
  ['files', 'spaceRemovalGoesFiles'],
  ['catalogs', 'spaceRemovalGoesCatalogs'],
  ['tasks', 'spaceRemovalGoesTasks'],
  ['launches', 'spaceRemovalGoesLaunches'],
  ['accounts', 'spaceRemovalGoesAccounts'],
  ['storedVideos', 'spaceRemovalGoesVideos'],
  ['pendingInvitations', 'spaceRemovalGoesInvitations']
];

/**
 * The way out of a space, from wherever the space is shown (2026-11-25).
 *
 * A space used to be able to hang in the list with nothing to press — "being set up", forever.
 * Now everyone has an exit that fits their place in it:
 *   - a member leaves, after a plain confirmation;
 *   - an owner with people in the space is told why it cannot simply go — their work is in it —
 *     and is handed the ownership transfer right here, not sent to find it;
 *   - an owner alone deletes it, after reading what goes and what stays, by holding the button
 *     for five seconds: deleting a whole space should be a decision, not a reflex.
 */
export function SpaceRemovalDialog({
  space,
  client,
  onClose,
  onRemoved,
  onTransferred
}: {
  space: TeamContextSnapshot;
  client: SpaceRemovalClient;
  onClose: () => void;
  /** The person is no longer in the space: it left their list. */
  onRemoved: () => void;
  /** Someone else owns the space now; the person stays in it. */
  onTransferred: () => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const isOwner = space.role === 'owner';
  const [preview, setPreview] = useState<SpaceRemovalPreview | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<TeamMemberSummary[] | null>(null);

  useEffect(() => {
    if (!isOwner) return;
    const controller = new AbortController();
    setLoadFailed(false);
    client
      .getSpaceRemovalPreview(space.id, { signal: controller.signal })
      .then(value => {
        if (!controller.signal.aborted) setPreview(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadFailed(true);
      });
    return () => controller.abort();
  }, [attempt, client, isOwner, space.id]);

  const fail = (cause: unknown) => push({ tone: 'error', text: teamErrorMessageFor(cause, t) });

  if (!isOwner) {
    const leave = async () => {
      setBusy(true);
      try {
        await client.leaveTeam(space.id);
        // Leaving does not touch Drive's own sharing, and the person should hear that now.
        push({ tone: 'info', text: t('teamLeaveDone'), sticky: true });
        onRemoved();
      } catch (cause) {
        fail(cause);
        setBusy(false);
      }
    };
    return (
      <ConfirmDialog
        title={t('spaceRemovalLeaveTitle', { name: space.name })}
        body={t('teamLeaveConfirmBody')}
        confirmLabel={t('teamLeaveAction')}
        cancelLabel={t('teamCancel')}
        busy={busy}
        onCancel={onClose}
        onConfirm={() => void leave()}
      />
    );
  }

  if (!preview) {
    return (
      <Modal title={t('spaceRemovalDeleteTitle', { name: space.name })} size="sm" onClose={onClose}>
        {loadFailed ? (
          <ErrorState
            message={t('spaceRemovalPreviewFailed')}
            onRetry={() => setAttempt(value => value + 1)}
          />
        ) : (
          <LoadingState label={t('spaceRemovalPreviewLoading')} />
        )}
      </Modal>
    );
  }

  if (preview.otherMembers > 0) {
    const openTransfer = async () => {
      setBusy(true);
      try {
        const members = await client.listMembers(space.id);
        setCandidates(members.filter(member => member.role !== 'owner'));
      } catch (cause) {
        fail(cause);
      } finally {
        setBusy(false);
      }
    };
    // One dialog at a time: the transfer takes the place of the explanation, and closing it
    // comes back to the explanation rather than to the list.
    if (candidates) {
      return (
        <OwnershipTransferDialog
          members={candidates}
          onClose={() => setCandidates(null)}
          onTransfer={async (toUserId, demoteTo) => {
            await client.transferOwnership({ teamId: space.id, toUserId, demoteTo });
            push({ tone: 'success', text: t('spaceRemovalTransferredToast') });
            onTransferred();
          }}
        />
      );
    }
    return (
      <Modal
        title={t('spaceRemovalTransferFirstTitle')}
        size="sm"
        busy={busy}
        onClose={onClose}
        footer={
          <>
            <Button color="neutral" variant="ghost" onClick={onClose}>
              {t('teamCancel')}
            </Button>
            <Button color="primary" loading={busy} onClick={() => void openTransfer()}>
              {t('teamOwnershipTransferStart')}
            </Button>
          </>
        }
      >
        <p>{t('spaceRemovalTransferFirstBody', { name: space.name })}</p>
      </Modal>
    );
  }

  const remove = async () => {
    setBusy(true);
    try {
      await client.deleteSpace(space.id);
      push({ tone: 'success', text: t('spaceRemovalDeletedToast', { name: space.name }) });
      onRemoved();
    } catch (cause) {
      fail(cause);
      setBusy(false);
    }
  };
  const goes = GOES.filter(([key]) => Number(preview[key]) > 0);

  return (
    <ConfirmDialog
      title={t('spaceRemovalDeleteTitle', { name: space.name })}
      body={
        <div className="space-removal-body">
          <p>{t('spaceRemovalDeleteLead')}</p>
          <ul className="space-removal-list">
            {goes.map(([key, label]) => (
              <li key={key}>
                <span>{t(label)}</span>
                <span className="space-removal-count">{String(preview[key])}</span>
              </li>
            ))}
            <li>
              <span>{t('spaceRemovalGoesHistory')}</span>
            </li>
          </ul>
          <p className="space-removal-stays">
            {preview.driveFolder
              ? t('spaceRemovalStaysDrive', { folder: preview.driveFolder })
              : t('spaceRemovalStaysDriveNoFolder')}
          </p>
          {preview.tariff && <p className="space-removal-stays">{t('spaceRemovalTariffMoves')}</p>}
        </div>
      }
      confirmLabel={t('spaceRemovalDeleteAction')}
      cancelLabel={t('teamCancel')}
      holdHint={t('spaceRemovalHoldHint')}
      holdDuration="space"
      busy={busy}
      onCancel={onClose}
      onConfirm={() => void remove()}
    />
  );
}
