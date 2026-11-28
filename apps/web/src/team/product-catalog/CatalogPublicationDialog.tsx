import { CatalogPublicationFields } from './CatalogPublicationFields';
import { useCatalogPublicationVerification } from './useCatalogPublicationVerification';
import { withReadDeadline } from '../readCoordinator';
import { withCatalogCommandDeadline } from '../catalog-updater/catalogCommandCoordinator';
import { beginCatalogUiFlow } from '../catalog-updater/analytics';
import { teamErrorCodeOf } from '../errors';
import { useEffect, useId, useRef, useState } from 'react';
import {
  CatalogPublicationValidationError,
  type CatalogPublicationCommand,
  type CatalogPublicationSnapshot
} from '@video-compressor/shared';
import { privateCacheActor, privateCacheEpoch, usePrivateCacheEpoch } from '../private-cache-scope';
import { teamApi } from '../../api/team';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';
import { resolveCatalogPublicationDraft } from './catalogPublicationDraft';
import { CatalogPublicationBlockedNote } from './CatalogPublicationBlockedNote';
import { catalogFeedWording, useCatalogFeedSpace } from './CatalogFeedAddress';

/** How often «Публікуємо…» reads the publication until the write is verified. */
export const CATALOG_PUBLISH_NOW_POLL_MS = 3_000;
const CATALOG_PUBLISH_NOW_MAX_READS = 60;
export function CatalogPublicationDialog({
  teamId,
  catalogId,
  onClose,
  onChanged,
  clockOffsetMs = 0
}: {
  teamId: string;
  catalogId: string;
  onClose: () => void;
  onChanged: () => void;
  clockOffsetMs?: number;
}) {
  const { t } = useI18n(),
    title = useId(),
    epoch = usePrivateCacheEpoch(),
    actor = privateCacheActor();
  const feed = useCatalogFeedSpace(teamId);
  const flow = useRef<ReturnType<typeof beginCatalogUiFlow> | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmNow, setConfirmNow] = useState(false);
  /** «Опублікувати зараз» was accepted: follow the write until it is verified. */
  const [publishing, setPublishing] = useState<'publishing' | 'published' | null>(null);

  const saving = useRef(false);
  const clock = useRef<{ serverNow: number; observedAt: number } | null>(null);
  const owns = () => privateCacheActor() === actor && privateCacheEpoch() === epoch;
  const live = useRef(0),
    [snapshot, setSnapshot] = useState<CatalogPublicationSnapshot | null>(null),
    [pending, setPending] = useState(false),
    [unknown, setUnknown] = useState<string | null>(null),
    [error, setError] = useState('');
  const [delayed, setDelayed] = useState(false),
    [date, setDate] = useState(''),
    [time, setTime] = useState('12:00'),
    [zone, setZone] = useState('Europe/Kyiv'),
    [choice, setChoice] = useState<'earlier' | 'later' | undefined>();
  const key = actor ? `soty:catalog-publication:v1:${actor}:${teamId}:${catalogId}` : null;
  const read = async (requestId?: string) => {
    if (!owns()) return;
    const generation = live.current;
    if (requestId) {
      flow.current = beginCatalogUiFlow('publication', { parentFlowId: requestId });
      flow.current.stage('readback_requested');
    }
    try {
      const value = await withReadDeadline(
        signal => teamApi.readCatalogPublication(teamId, catalogId, requestId, { signal }),
        new AbortController().signal
      );
      if (generation !== live.current || !owns()) return;
      if (requestId) {
        if (!value) {
          setUnknown(requestId);
          return;
        }
        if (key) localStorage.removeItem(key);
        setUnknown(null);
        flow.current?.stage('save_confirmed');
        setSaved(true);
        onChanged();
        setSnapshot(null);
        await read();
        return;
      }
      if (value) {
        clock.current = { serverNow: value.serverNow, observedAt: performance.now() };
        setSnapshot(value);
        setDelayed(value.mode === 'scheduled');
        if (value.dueAt) {
          const local = new Intl.DateTimeFormat('sv-SE', {
            timeZone: value.timeZone ?? 'Europe/Kyiv',
            dateStyle: 'short',
            timeStyle: 'short'
          }).format(new Date(value.dueAt));
          setDate(local.slice(0, 10));
          setTime(local.slice(11, 16));
        }
        setZone(value.timeZone ?? 'Europe/Kyiv');
      }
      setError('');
    } catch (cause) {
      if (generation === live.current && owns()) setError(teamErrorMessageFor(cause, t));
    }
  };
  useEffect(() => {
    live.current++;
    setSnapshot(null);
    setUnknown(null);
    setError('');
    if (!actor || !key) return;
    let retained: string | null;
    try {
      retained = localStorage.getItem(key);
    } catch {
      setError(t('catalogPublicationStorageError'));
      return;
    }
    if (retained) {
      if (!/^[0-9a-f-]{36}$/iu.test(retained)) {
        setError(t('catalogPublicationStorageError'));
        return;
      }
      setUnknown(retained);
      void read(retained);
    } else void read();
    return () => {
      live.current++;
    };
  }, [teamId, catalogId, epoch]);
  const verification = useCatalogPublicationVerification({
    teamId,
    catalogId,
    confirmed: () => {
      setSnapshot(null);
      clock.current = null;
      setSaved(true);
      setError('');
      onChanged();
      void read();
    },
    failed: cause => setError(teamErrorMessageFor(cause, t))
  });
  useEffect(() => {
    if (saved) {
      flow.current?.complete();
      verification.visible();
    }
  });
  // After «Опублікувати зараз» the dialog said only «Налаштування публікації збережено»
  // and never showed the link going out (1.4.3 QA, 87 s later): follow it to «Опубліковано».
  const publishReads = useRef(0);
  // 072: the follow used to stop after its last read and leave «Публікуємо посилання…» on
  // screen for good — a blocked write looked exactly like one in progress. A blocked job ends
  // the follow (the note under the fields says why and what to press); a follow that ran out
  // says so and offers to check again.
  const [publishStalled, setPublishStalled] = useState(false);
  useEffect(() => {
    if (publishing !== 'publishing') {
      publishReads.current = 0;
      setPublishStalled(false);
      return;
    }
    if (snapshot?.job?.state === 'published') {
      setPublishing('published');
      return;
    }
    if (snapshot?.job?.state === 'blocked') {
      setPublishing(null);
      return;
    }
    if (publishReads.current >= CATALOG_PUBLISH_NOW_MAX_READS) {
      setPublishStalled(true);
      return;
    }
    const timer = setTimeout(() => {
      publishReads.current += 1;
      void read();
    }, CATALOG_PUBLISH_NOW_POLL_MS);
    return () => clearTimeout(timer);
  }, [publishing, snapshot]);
  const saveOwned = async (action?: 'add_now') => {
    if (
      !snapshot ||
      !actor ||
      !key ||
      pending ||
      unknown ||
      verification.pending ||
      verification.unknown ||
      !owns()
    )
      return;
    setError('');
    setSaved(false);
    const requestId = crypto.randomUUID();
    flow.current = beginCatalogUiFlow('publication', { parentFlowId: requestId });
    flow.current.stage('save_requested');
    let command: CatalogPublicationCommand;
    try {
      let publication: CatalogPublicationCommand['publication'];
      if (action === 'add_now') publication = { mode: 'immediate' };
      else if (delayed) {
        const resolved = resolveCatalogPublicationDraft(
          { localDateTime: `${date}T${time}`, timeZone: zone, choice },
          Math.round(
            clock.current
              ? clock.current.serverNow + performance.now() - clock.current.observedAt
              : Date.now() + clockOffsetMs
          )
        );
        if (resolved.kind === 'ambiguous') {
          setError(t('catalogPublicationAmbiguous'));
          flow.current?.fail('VALIDATION');
          return;
        }
        publication = resolved.publication;
      } else publication = { mode: 'held' };
      command = {
        requestId,
        catalogId,
        expectedRevision: snapshot.revision,
        target: snapshot.target,
        publication
      };
      localStorage.setItem(key, command.requestId);
    } catch (cause) {
      flow.current?.fail('VALIDATION');
      setError(
        cause instanceof CatalogPublicationValidationError
          ? t('catalogPublicationInvalid')
          : t('catalogPublicationStorageError')
      );
      return;
    }
    const generation = live.current;
    setPending(true);
    try {
      const saved = await withCatalogCommandDeadline(
        signal =>
          action === 'add_now'
            ? teamApi.changeCatalogPublication(
                teamId,
                {
                  catalogId,
                  requestId: command.requestId,
                  expectedRevision: command.expectedRevision,
                  action
                },
                { signal }
              )
            : teamApi.saveCatalogPublication(teamId, command, { signal }),
        new AbortController().signal
      );
      if (generation !== live.current || !owns()) return;
      localStorage.removeItem(key);
      setSnapshot(saved);
      flow.current?.stage('save_confirmed');
      setSaved(true);
      if (action === 'add_now')
        setPublishing(saved.job?.state === 'published' ? 'published' : 'publishing');
      onChanged();
    } catch (cause) {
      if (generation === live.current && owns()) {
        const code = teamErrorCodeOf(cause);
        if (
          code &&
          [
            'INVALID_INPUT',
            'PERMISSION_DENIED',
            'SOURCE_CHANGED',
            'WRONG_STATE',
            'NOT_FOUND',
            'RESTITCH_CLIENT_OUTDATED'
          ].includes(code)
        ) {
          try {
            localStorage.removeItem(key);
            setUnknown(null);
            flow.current?.fail(code);
          } catch {
            setUnknown(command.requestId);
          }
        } else {
          setUnknown(command.requestId);
          flow.current?.stage('stale', code ?? 'UNKNOWN');
        }
        setError(teamErrorMessageFor(cause, t));
      }
    } finally {
      if (generation === live.current && owns()) setPending(false);
    }
  };
  const save = async (action?: 'add_now') => {
    if (saving.current) return;
    saving.current = true;
    try {
      await saveOwned(action);
    } finally {
      saving.current = false;
    }
  };
  return (
    <Modal
      labelledBy={title}
      closeLabel={t('teamClose')}
      onClose={() => {
        if (!pending && !verification.pending) onClose();
      }}
    >
      <h2 id={title}>{t('catalogPublicationTitle')}</h2>
      <p className="field-hint">{t('catalogPublicationExplanation')}</p>
      {snapshot?.providerCas === 'unsupported' &&
        snapshot.writerMode !== 'video_columns' &&
        snapshot.job?.state !== 'published' && (
          <p className="team-inline-note" role="status">
            {t('catalogWriteUnsupported')}
          </p>
        )}
      {unknown || verification.unknown ? (
        <>
          <p role="status">{t('catalogPublicationUnknown')}</p>
          <Button
            color="neutral"
            disabled={verification.pending}
            onClick={() => void (unknown ? read(unknown) : verification.check())}
          >
            {t('catalogPublicationCheck')}
          </Button>
        </>
      ) : (
        <>
          <CatalogPublicationFields
            value={{ delayed, date, time, zone, occurrence: choice }}
            disabled={pending || verification.pending || !snapshot}
            onChange={next => {
              setSaved(false);
              setDelayed(next.delayed);
              setDate(next.date);
              setTime(next.time);
              setZone(next.zone);
              setChoice(next.occurrence);
            }}
          />
          <Button
            color="neutral"
            disabled={pending || verification.pending || !snapshot || saved}
            onClick={() => void save()}
          >
            {t('catalogScheduleSave')}
          </Button>
          {/* Publishing now writes into the sheet at once: a secondary action with its
              own confirmation, not an equal button above «Зберегти» (1.4.3 QA). */}
          {confirmNow ? (
            <div className="catalog-publication-confirm" role="group">
              <p>{t(catalogFeedWording('catalogPublicationAddNowConfirm', feed))}</p>
              <Button
                variant="secondary"
                disabled={pending || verification.pending || !snapshot}
                onClick={() => {
                  setConfirmNow(false);
                  void save('add_now');
                }}
              >
                {t('catalogPublicationAddNowConfirmAction')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmNow(false)}>
                {t('cancel')}
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              disabled={
                pending ||
                verification.pending ||
                !snapshot ||
                publishing !== null ||
                snapshot.job?.state === 'published'
              }
              onClick={() => setConfirmNow(true)}
            >
              {t('catalogPublicationAddNow')}
            </Button>
          )}
        </>
      )}
      {snapshot?.job?.blockedReason === 'legacy_adoption_required' && (
        <p role="status" className="team-inline-note">
          {t('catalogPublicationLegacyHold')}
        </p>
      )}
      {snapshot?.job?.blockedReason === 'legacy_adoption_required' &&
        !unknown &&
        !verification.unknown && (
          <Button
            color="neutral"
            disabled={pending || verification.pending}
            onClick={() => void verification.verify(snapshot.revision)}
          >
            {t('catalogPublicationVerify')}
          </Button>
        )}
      {snapshot && !unknown && !verification.unknown && (
        <CatalogPublicationBlockedNote
          teamId={teamId}
          catalogId={catalogId}
          snapshot={snapshot}
          onRetried={() => {
            onChanged();
            // Follow only once the requeued job is read: the blocked snapshot still on screen
            // would end the follow at once.
            void read().then(() => setPublishing('publishing'));
          }}
        />
      )}
      {publishing === 'publishing' && publishStalled ? (
        <>
          <p role="status">{t('catalogPublicationStillPending')}</p>
          <Button
            color="neutral"
            onClick={() => {
              publishReads.current = 0;
              setPublishStalled(false);
              void read();
            }}
          >
            {t('catalogPublicationCheck')}
          </Button>
        </>
      ) : publishing === 'publishing' ? (
        <p role="status">{t('catalogPublicationPublishing')}</p>
      ) : publishing === 'published' ? (
        <p role="status">{t('catalogPublicationPublished')}</p>
      ) : (
        saved && <p role="status">{t('catalogPublicationSaved')}</p>
      )}
      {error && (
        <p role="alert" className="team-inline-error">
          {error}
        </p>
      )}
      {(!snapshot || error) && !unknown && !verification.unknown && (
        <Button
          color="neutral"
          disabled={pending || verification.pending}
          onClick={() => void read()}
        >
          {t('catalogPublicationCheck')}
        </Button>
      )}
    </Modal>
  );
}
