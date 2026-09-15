import { useCallback, useEffect, useState } from 'react';
import type { CatalogUpdaterState } from '../../api/team';
import { enrollUpdaterAgent, readUpdaterAgent, type UpdaterAgentStatus } from '../../api/client';
import { Button, Checkbox } from '../../components/ui';
import { useToasts } from '../../components/toast';
import { useI18n } from '../../i18n';
import { teamErrorMessageFor } from '../errors';

export interface RestitchDeviceClient {
  enrollUpdaterDevice: (
    teamId: string,
    input: { label: string; build: string; contracts: Record<string, number> }
  ) => Promise<{ deviceId: string; secret: string }>;
}

export interface RestitchAgentClient {
  readUpdaterAgent: () => Promise<UpdaterAgentStatus | null>;
  enrollUpdaterAgent: (input: {
    teamId: string;
    deviceId: string;
    secret: string;
  }) => Promise<void>;
}

const defaultAgentClient: RestitchAgentClient = { readUpdaterAgent, enrollUpdaterAgent };

/**
 * Re-stitching, and the computer that does it (023, delivery 2).
 *
 * One computer re-stitches for a space. Turning the option on with no computer there makes this one
 * it — the server issues a secret and the page hands it straight to the local app. The line under the
 * option says which computer it is, whether it is there, and how many spares are ready.
 */
export function RestitchDevicePicker({
  teamId,
  state,
  restitch,
  disabled,
  client,
  agentClient = defaultAgentClient,
  onRestitchChange,
  onEnrolled
}: {
  teamId: string;
  state: CatalogUpdaterState | null;
  restitch: boolean;
  disabled: boolean;
  client: RestitchDeviceClient;
  agentClient?: RestitchAgentClient;
  onRestitchChange: (restitch: boolean) => void;
  /** The server's state changed: a device was enrolled. */
  onEnrolled: () => void;
}) {
  const { t } = useI18n();
  const { push } = useToasts();
  const [agent, setAgent] = useState<UpdaterAgentStatus | null>(null);
  const [enrolling, setEnrolling] = useState(false);

  const readAgent = useCallback(() => {
    void agentClient.readUpdaterAgent().then(setAgent);
  }, [agentClient]);
  useEffect(readAgent, [readAgent]);

  const device = state?.device ?? null;
  const usable = device !== null && device.online && !device.tooOld;
  const thisComputer = device !== null && agent?.enrolled?.deviceId === device.id;

  const enroll = async (): Promise<boolean> => {
    if (!agent) return false;
    setEnrolling(true);
    try {
      const issued = await client.enrollUpdaterDevice(teamId, {
        label: agent.label,
        build: agent.build,
        contracts: agent.toolContracts
      });
      await agentClient.enrollUpdaterAgent({ teamId, ...issued });
      onEnrolled();
      readAgent();
      return true;
    } catch (error) {
      push({
        tone: 'error',
        text:
          error instanceof Error && error.message === 'AGENT_UPDATE_REQUIRED'
            ? t('catalogUpdaterRestitchSoon')
            : teamErrorMessageFor(error, t)
      });
      return false;
    } finally {
      setEnrolling(false);
    }
  };

  const toggle = async (checked: boolean) => {
    if (!checked) return onRestitchChange(false);
    if (usable) return onRestitchChange(true);
    if (await enroll()) onRestitchChange(true);
  };

  const status = !device
    ? null
    : device.tooOld
      ? t('catalogUpdaterDeviceTooOld')
      : device.online
        ? t('catalogUpdaterDeviceOnline')
        : t('catalogUpdaterDeviceOffline');

  return (
    <div className="team-updater-restitch">
      <Checkbox
        checked={restitch}
        disabled={disabled || enrolling || (!restitch && !usable && !agent)}
        onChange={event => void toggle(event.target.checked)}
        label={t('catalogUpdaterRestitch')}
      />
      {device ? (
        <small className={device.online && !device.tooOld ? undefined : 'team-updater-attention'}>
          {t('catalogUpdaterDevice', { label: device.label })}
          {thisComputer ? ` (${t('catalogUpdaterDeviceThis')})` : ''} · {status}
        </small>
      ) : agent ? (
        <small>{t('catalogUpdaterRestitchHint')}</small>
      ) : (
        <small>{t('catalogUpdaterRestitchSoon')}</small>
      )}
      {agent && device && !thisComputer && (
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || enrolling}
          loading={enrolling}
          onClick={() => void enroll()}
        >
          {t('catalogUpdaterUseThisComputer')}
        </Button>
      )}
      {state?.state === 'running' && state.restitch && state.spareReadyCount !== null && (
        <small>
          {t('catalogUpdaterSparesReady', {
            ready: state.spareReadyCount,
            count: state.catalogCount
          })}
        </small>
      )}
    </div>
  );
}
