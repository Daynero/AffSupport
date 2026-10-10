import { useState } from 'react';
import type { AdminTariffRow } from '@video-compressor/shared';
import type { AdminTariffClient } from '../../api/team';
import { Alert, Button, Modal } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../../team/errors';
import { pluralForm } from '../../team/tariffs/format';
import { peopleOnSeats } from './tariffModel';

/**
 * «Відкликати» (034, US3.3, FR-015) — two ways, both named for what they do:
 * end the term today (the ordinary three days follow), or close the space now.
 * Data stays either way, and the dialog says so beside the number of people
 * who lose access. A grant still waiting for its owner is simply cancelled.
 */
export function TariffEndDialog({
  row,
  client,
  onClose,
  onEnded
}: {
  row: AdminTariffRow;
  client: AdminTariffClient;
  onClose: () => void;
  onEnded: (row: AdminTariffRow) => void;
}) {
  const { t, language } = useI18n();
  const [busy, setBusy] = useState<'today' | 'now' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const waiting = row.state === 'pending' || row.state === 'pending_expired';
  const people = peopleOnSeats(row);

  const end = async (now: boolean) => {
    setBusy(now ? 'now' : 'today');
    setError(null);
    try {
      onEnded(await client.end(row.id, now));
    } catch (cause) {
      setError(teamErrorMessageFor(cause, t));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title={
        waiting
          ? t('adminTariffCancelGrantTitle', { email: row.ownerEmail })
          : t('adminTariffEndTitle', { email: row.ownerEmail })
      }
      size="sm"
      busy={busy !== null}
      footer={
        waiting ? (
          <>
            <Button
              color="error"
              variant="soft"
              loading={busy === 'now'}
              onClick={() => void end(true)}
            >
              {t('adminTariffCancelGrant')}
            </Button>
            <Button color="neutral" variant="outline" disabled={busy !== null} onClick={onClose}>
              {t('teamCancel')}
            </Button>
          </>
        ) : (
          <>
            <Button
              color="error"
              variant="soft"
              loading={busy === 'now'}
              disabled={busy === 'today'}
              onClick={() => void end(true)}
            >
              {t('adminTariffCloseNow')}
            </Button>
            <Button
              color="warning"
              variant="soft"
              loading={busy === 'today'}
              disabled={busy === 'now'}
              onClick={() => void end(false)}
            >
              {t('adminTariffEndToday')}
            </Button>
            <Button color="neutral" variant="outline" disabled={busy !== null} onClick={onClose}>
              {t('teamCancel')}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {!waiting && (
          <>
            <p className="prose">{t('adminTariffEndBody')}</p>
            <p className="prose">
              {people > 0
                ? t(
                    pluralForm(language, people, {
                      one: 'adminTariffEndPeopleOne',
                      few: 'adminTariffEndPeopleFew',
                      many: 'adminTariffEndPeopleMany'
                    }),
                    { count: people }
                  )
                : t('adminTariffEndNobody')}
            </p>
            {row.legacyAlso && (
              <Alert color="warning" variant="subtle">
                {t('adminTariffEndLegacy')}
              </Alert>
            )}
          </>
        )}
        {waiting && <p className="prose">{t('adminTariffCancelGrantBody')}</p>}
        {error && (
          <Alert color="error" live="alert">
            {error}
          </Alert>
        )}
      </div>
    </Modal>
  );
}
