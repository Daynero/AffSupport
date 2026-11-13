import { useEffect, useId, useRef, useState } from 'react';
import type {
  CatalogRenameContext,
  CatalogRenameReceipt,
  TeamErrorCode
} from '@video-compressor/shared';
import { Button, FormField, Input, Modal } from '../../components/ui/index.js';
import { useI18n } from '../../i18n.js';
import {
  catalogRenameApi,
  matchingCatalogRenameReceipt,
  type CatalogRenameClient
} from '../../api/catalog-rename.js';
import { TeamApiError } from '../../api/team.js';
import {
  privateCacheActor,
  privateCacheEpoch,
  privateClientId,
  usePrivateCacheEpoch
} from '../private-cache-scope.js';
import {
  WorkspaceMutationJournal,
  type WorkspaceMutationIntent
} from '../workspace/mutationJournal.js';
import { withCatalogCommandDeadline } from '../catalog-updater/catalogCommandCoordinator.js';
import { useScopedRefresh } from '../useScopedRefresh.js';
import { teamErrorMessageFor } from '../errors.js';
import {
  startTeamFileAttempt,
  completeTeamFileAttempt,
  type TeamFileAttemptFlow
} from '../../analytics/service.js';
import { reportFileAttemptError } from '../catalog/useMaterialActions.js';

export interface CatalogRenameDialogProps {
  teamId: string;
  materialId: string;
  currentName: string;
  open: boolean;
  disabled?: boolean;
  onClose: () => void;
  onRenamed: (name: string) => void;
  surface?: 'material' | 'catalog_manager';
  client?: CatalogRenameClient;
}
const definiteRejection = (error: unknown) =>
  error instanceof TeamApiError &&
  [
    'AUTH_REQUIRED',
    'PERMISSION_DENIED',
    'SPACE_BLOCKED',
    'INVALID_INPUT',
    'NOT_FOUND',
    'WRONG_STATE',
    'SOURCE_CHANGED',
    'NAME_CONFLICT'
  ].includes(error.code);

/** A new private scope unmounts every old callback, draft and pending observation. */
export function CatalogRenameDialog(props: CatalogRenameDialogProps) {
  const epoch = usePrivateCacheEpoch();
  return (
    <CatalogRenameSession
      key={`${epoch}:${props.teamId}:${props.materialId}:${privateClientId(props.client ?? catalogRenameApi)}`}
      {...props}
    />
  );
}
function CatalogRenameSession({
  teamId,
  materialId,
  currentName,
  open,
  disabled = false,
  onClose,
  onRenamed,
  surface = 'material',
  client = catalogRenameApi
}: CatalogRenameDialogProps) {
  const { t } = useI18n();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const actor = privateCacheActor();
  const epoch = privateCacheEpoch();
  const mounted = useRef(true);
  const callbacks = useRef({ onClose, onRenamed, disabled });
  callbacks.current = { onClose, onRenamed, disabled };
  const current = () =>
    mounted.current && privateCacheEpoch() === epoch && privateCacheActor() === actor;
  const [persistence] = useState(() => {
    try {
      if (!actor) throw new TeamApiError('AUTH_REQUIRED', false);
      const journal = new WorkspaceMutationJournal('catalog-rename', actor, teamId, localStorage);
      return {
        journal,
        pending: journal.list().find(item => item.materialIds.includes(materialId)) ?? null,
        error: null
      };
    } catch (error) {
      return { journal: null, pending: null, error };
    }
  });
  const [pending, setPending] = useState<WorkspaceMutationIntent | null>(persistence.pending);
  const [readBlocked, setReadBlocked] = useState(false);
  const initialContext = useRef(true);
  const [context, setContext] = useState<CatalogRenameContext | null>(null);
  const [name, setName] = useState(currentName);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<unknown>(persistence.error);
  const [notSubmitted, setNotSubmitted] = useState(false);
  const attempt = useRef<TeamFileAttemptFlow | null>(null);
  const delivered = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    setContext(null);
    setReadBlocked(false);
    initialContext.current = true;
    setName(currentName);
    setConfirming(false);
    setError(persistence.error);
    setNotSubmitted(false);
    // A reopening always obtains a fresh impact proof; typed drafts never persist.
  }, [open]);
  useEffect(() => {
    if (open && context && !disabled && !pending) inputRef.current?.focus();
  }, [context, open, disabled]);
  const begin = (requestKey: string) => {
    attempt.current ??= startTeamFileAttempt({
      action: 'rename',
      flowId: requestKey,
      surface,
      storageKind: 'unknown',
      sizeBucket: 'tiny'
    });
  };
  const report = (cause: unknown) => {
    if (!attempt.current) return;
    completeTeamFileAttempt(attempt.current, {
      outcome: 'failure',
      retryable: cause instanceof TeamApiError && cause.retryable
    });
    reportFileAttemptError(attempt.current, cause);
    attempt.current = null;
  };
  const observe = (value: CatalogRenameReceipt, intent: WorkspaceMutationIntent) => {
    if (!current()) return;
    const receipt = matchingCatalogRenameReceipt(value, {
      teamId,
      materialId,
      requestKey: intent.id
    });
    if (receipt.state === 'pending') return;
    if (receipt.state === 'confirmed' && delivered.current !== receipt.requestKey) {
      delivered.current = receipt.requestKey;
      callbacks.current.onRenamed(receipt.currentName!);
      if (attempt.current)
        completeTeamFileAttempt(attempt.current, { outcome: 'success', retryable: false });
      attempt.current = null;
    }
    // Failure to remove the durable fence must never enable a new request.
    persistence.journal?.confirmed(intent.id);
    setPending(null);
    if (receipt.state === 'confirmed') callbacks.current.onClose();
    else {
      const failure = new TeamApiError(receipt.errorCode as TeamErrorCode, false);
      setNotSubmitted(receipt.errorCode === 'NOT_FOUND' && receipt.operationId === null);
      setError(failure);
      report(failure);
      setContext(null);
      setConfirming(false);
    }
  };
  const refresh = useScopedRefresh({
    scope: `catalog-rename:${epoch}:${teamId}:${materialId}:${pending?.id ?? 'context'}`,
    source: client,
    revision: 0,
    enabled: Boolean(
      actor &&
      !persistence.error &&
      !readBlocked &&
      !submitting &&
      (pending || (open && !context && !disabled))
    ),
    intervalMs: 3000,
    load: async signal => {
      if (!actor || !current()) return null;
      try {
        if (pending) {
          begin(pending.id);
          const receipt = await client.status(
            { teamId, materialId, expectedActorId: actor, requestKey: pending.id },
            signal
          );
          if (receipt) observe(receipt, pending);
          return receipt;
        }
        const snapshot = await client.context(
          { teamId, materialId, expectedActorId: actor },
          signal
        );
        if (current() && !signal.aborted) {
          if (snapshot.teamId !== teamId || snapshot.materialId !== materialId)
            throw new TeamApiError('INVALID_RESPONSE', false);
          setContext(snapshot);
          if (initialContext.current) {
            initialContext.current = false;
            setName(snapshot.currentName);
          }
        }
        return snapshot;
      } catch (cause) {
        if (current() && definiteRejection(cause)) {
          setReadBlocked(true);
          setError(cause);
        }
        throw cause;
      }
    }
  });
  const submit = async (acknowledgeBoundNames: boolean) => {
    if (
      !current() ||
      !actor ||
      callbacks.current.disabled ||
      submittingRef.current ||
      pending ||
      !context ||
      !persistence.journal
    )
      return;
    if (context.requiresAcknowledgement && !acknowledgeBoundNames) {
      setConfirming(true);
      return;
    }
    let intent: WorkspaceMutationIntent;
    try {
      const previous = persistence.journal
        .list()
        .find(item => item.materialIds.includes(materialId));
      if (previous) {
        setPending(previous);
        return;
      }
      intent = persistence.journal.acquire([materialId]);
    } catch (cause) {
      setError(cause);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setPending(intent);
    setError(null);
    setNotSubmitted(false);
    begin(intent.id);
    const controller = new AbortController();
    try {
      const receipt = await withCatalogCommandDeadline(
        signal =>
          client.submit(
            {
              teamId,
              materialId,
              expectedActorId: actor,
              requestKey: intent.id,
              newName: name.trim(),
              expectedMaterialVersion: context.materialVersion,
              impactVersion: context.impactVersion,
              acknowledgeBoundNames
            },
            signal
          ),
        controller.signal
      );
      observe(receipt, intent);
    } catch (cause) {
      if (!current()) return;
      if (definiteRejection(cause)) {
        try {
          persistence.journal.confirmed(intent.id);
          setPending(null);
        } catch {
          /* Retain uncertain storage fence. */
        }
        setError(cause);
        report(cause);
        setContext(null);
        setConfirming(false);
      }
      // Transport loss keeps the same intent; the shared read cadence reconciles it.
    } finally {
      submittingRef.current = false;
      if (current()) setSubmitting(false);
    }
  };
  if (!open) return null;
  const waiting = Boolean(pending || submitting);
  const valid =
    name.trim().length > 0 && name.trim().length <= 1024 && !/[\p{Cc}\p{Cs}]/u.test(name);
  return (
    <Modal
      nested
      size="sm"
      title={t('launchCatalogRenameTitle')}
      onClose={onClose}
      initialFocus={`#${CSS.escape(inputId)}`}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={event => {
          event.preventDefault();
          void submit(confirming);
        }}
      >
        <FormField label={t('teamFileNewName')} htmlFor={inputId}>
          <Input
            id={inputId}
            ref={inputRef}
            value={name}
            maxLength={1024}
            disabled={disabled || waiting || confirming || !context}
            onChange={event => {
              setName(event.target.value);
              setConfirming(false);
            }}
          />
        </FormField>
        {confirming && context?.requiresAcknowledgement && (
          <div className="catalog-rename-warning" role="note">
            <p>{t('launchCatalogRenameWarning')}</p>
            <ul>
              {context.boundNames.map(bound => (
                <li key={bound}>{bound}</li>
              ))}
            </ul>
          </div>
        )}
        {waiting && (
          <p className="text-label text-muted" role="status">
            {t('launchCatalogRenamePending')}
          </p>
        )}
        {!waiting && !context && !error && (
          <p className="text-label text-muted" role="status">
            {t(refresh.error ? 'launchCatalogRenameConnecting' : 'launchCatalogRenameLoading')}
          </p>
        )}
        {Boolean(error) && (
          <p className="ui-field-error" role="alert">
            {notSubmitted ? t('launchCatalogRenameNotSubmitted') : teamErrorMessageFor(error, t)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t(waiting ? 'teamClose' : 'teamCancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            loading={submitting}
            disabled={
              disabled || waiting || !context || !valid || name.trim() === context.currentName
            }
          >
            {t(confirming ? 'launchCatalogRenameOk' : 'teamFileRename')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
