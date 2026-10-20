import { useEffect, useRef, useState } from 'react';
import {
  nextTeamAccountNameColor,
  TEAM_ACCOUNT_NAME_COLORS,
  type TeamAccountAgentSummary,
  type TeamAccountNameColor
} from '@video-compressor/shared';
import { accountsWorkspaceApi } from '../../api/team-accounts-workspace';
import { accountFlowId, emitAccountSignal } from './analytics';
function boundedColor(value: unknown): TeamAccountNameColor {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 7
    ? (value as TeamAccountNameColor)
    : 0;
}
export function useAccountPreferences(
  teamId: string,
  agents: readonly TeamAccountAgentSummary[],
  onError: (cause: unknown) => void
) {
  const [colors, setColors] = useState<Record<string, TeamAccountNameColor>>({});
  const [, setProofRevision] = useState(0);
  const presentation = useRef(
    new Map<string, { color: TeamAccountNameColor; flow: string; attempt: string }>()
  );
  const active = useRef(true);
  const pending = useRef(
    new Map<string, { desired: TeamAccountNameColor; version: string; running: boolean }>()
  );
  const latest = useRef(agents);
  latest.current = agents;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      pending.current.clear();
      presentation.current.clear();
    };
  }, [teamId]);
  useEffect(() => {
    setColors(current => {
      let changed = false;
      const next = { ...current };
      for (const agent of agents) {
        const state = pending.current.get(agent.id);
        if (state?.running) continue;
        const version = agent.nameColorVersion ?? '0';
        if (state && BigInt(version) < BigInt(state.version)) continue;
        const color = boundedColor(agent.nameColor);
        if (state) {
          state.version = version;
          state.desired = color;
        }
        if (next[agent.id] !== undefined && next[agent.id] !== color) {
          next[agent.id] = color;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [agents]);
  const cycle = (agent: TeamAccountAgentSummary) => {
    presentation.current.delete(agent.id);
    const state = pending.current.get(agent.id) ?? {
      desired: boundedColor(agent.nameColor),
      version: agent.nameColorVersion ?? '0',
      running: false
    };
    state.desired = nextTeamAccountNameColor(state.desired);
    pending.current.set(agent.id, state);
    setColors(current => ({ ...current, [agent.id]: state.desired }));
    if (state.running) return;
    state.running = true;
    void (async () => {
      const flow = accountFlowId();
      let attempt: string | undefined;
      try {
        while (active.current) {
          const desired = state.desired;
          const requestId = crypto.randomUUID();
          attempt = requestId;
          emitAccountSignal('decoration', 'requested', {
            flowId: flow,
            attemptId: attempt,
            entity: 'rk'
          });
          const version = state.version;
          const write = () =>
            accountsWorkspaceApi.color(teamId, agent.id, desired, version, requestId);
          const result = await write().catch(cause => {
            // An interrupted response does not prove the preference failed.
            // Replay the exact receipt once; never manufacture a second write.
            if (
              !active.current ||
              !(cause instanceof Error) ||
              !/network|fetch|timeout|disconnected/i.test(cause.message)
            )
              throw cause;
            return write();
          });
          if (!active.current) return;
          state.version = result.version;
          emitAccountSignal('decoration', 'accepted', {
            flowId: flow,
            attemptId: attempt,
            outcome: 'success',
            result: 'complete'
          });
          if (state.desired === desired) {
            presentation.current.set(agent.id, { color: desired, flow, attempt });
            setProofRevision(revision => revision + 1);
            break;
          }
        }
      } catch (cause) {
        if (active.current) {
          const canonical = latest.current.find(item => item.id === agent.id);
          state.desired = boundedColor(canonical?.nameColor);
          state.version = canonical?.nameColorVersion ?? '0';
          setColors(current => ({ ...current, [agent.id]: state.desired }));
          onError(cause);
          emitAccountSignal('decoration', 'terminal', {
            flowId: flow,
            attemptId: attempt,
            outcome: 'failure',
            result: 'failed',
            code: cause instanceof Error ? cause.message : 'UNKNOWN'
          });
        }
      } finally {
        state.running = false;
      }
    })();
  };
  return {
    cycle,
    hasPresentationProof: presentation.current.size > 0,
    // Called after the owning Accounts panel commits. A saved preference on a
    // folded, filtered or deferred row is not proof that its name was shown.
    confirmPresentation: (root: HTMLElement | null) => {
      if (!active.current || !root) return;
      for (const row of root.querySelectorAll<HTMLElement>('[data-agent-row-id]')) {
        const id = row.dataset.agentRowId;
        const proof = id ? presentation.current.get(id) : undefined;
        if (
          !id ||
          !proof ||
          !row.isConnected ||
          row.closest('[hidden], [aria-hidden="true"], .is-collapsed') ||
          row.querySelector<HTMLElement>('[data-name-color]')?.dataset.color !==
            TEAM_ACCOUNT_NAME_COLORS[proof.color]
        )
          continue;
        presentation.current.delete(id);
        emitAccountSignal('decoration', 'applied', {
          flowId: proof.flow,
          attemptId: proof.attempt,
          outcome: 'success',
          result: 'complete'
        });
      }
    },
    color: (agent: TeamAccountAgentSummary) => colors[agent.id] ?? boundedColor(agent.nameColor)
  };
}
