import { useEffect, useRef, useState } from 'react';
import {
  applyLaunchDefaultValues,
  launchDefaultValues,
  launchValuesEqual,
  type LaunchDraft
} from '@video-compressor/shared';
import { launchApi } from '../../api/team';
import { observeLaunchDefaults } from '../../analytics/launch-defaults';
import { newLaunchDraft } from './launchDraftDefaults';

type Profile = Awaited<ReturnType<typeof launchApi.defaults>>;
export function resolvedLaunchDefaults(profile: Profile): LaunchDraft {
  const next = {
    ...launchDefaultValues(newLaunchDraft()),
    ...launchDefaultValues(profile?.config ?? {}),
    ...(profile ? { subConfig: profile.subConfig } : {})
  };
  // Older profiles used max/count allocation, not today's explicit minimum.
  if (profile && profile.config.minBudget === undefined && profile.config.maxBudget !== undefined)
    delete next.minBudget;
  return next;
}

export function useOfferDefaults({
  teamId,
  config,
  workspace,
  existing,
  disabled,
  buyers,
  onApply
}: {
  teamId: string;
  config: LaunchDraft;
  workspace: Profile;
  existing: boolean;
  disabled: boolean;
  buyers: { id: string }[];
  onApply: (next: LaunchDraft) => void;
}) {
  const openedExisting = useRef(existing);
  const readFlow = useRef<{ offerId?: string; id: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{
    offerId?: string;
    loading: boolean;
    error?: unknown;
    profile: Profile;
  }>({ loading: Boolean(config.offerId), profile: null });
  const [proposal, setProposal] = useState<{
    offerId?: string;
    values: LaunchDraft;
    source: 'offer' | 'workspace' | 'builtin';
  } | null>(null);
  const [source, setSource] = useState<'offer' | 'workspace' | 'builtin' | 'current'>(
    existing ? 'current' : workspace ? 'workspace' : 'builtin'
  );
  const baseline = useRef(
    existing ? launchDefaultValues(config) : resolvedLaunchDefaults(workspace)
  );
  const [buyerMissing, setBuyerMissing] = useState(false);
  const latest = useRef({ config, workspace, existing, disabled, buyers, onApply });
  latest.current = { config, workspace, existing, disabled, buyers, onApply };
  const applied = useRef<ReturnType<typeof observeLaunchDefaults> | null>(null);
  const apply = (values: LaunchDraft, nextSource: 'offer' | 'workspace' | 'builtin') => {
    if (latest.current.disabled) return;
    const safe = { ...values };
    const missing = Boolean(
      safe.buyerId && !latest.current.buyers.some(row => row.id === safe.buyerId)
    );
    if (missing) delete safe.buyerId;
    setBuyerMissing(missing);
    applied.current = observeLaunchDefaults(
      'apply',
      nextSource === 'offer' ? 'offer' : 'workspace'
    );
    baseline.current = safe;
    setSource(nextSource);
    setProposal(null);
    latest.current.onApply(applyLaunchDefaultValues(latest.current.config, safe));
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    if (applied.current && launchValuesEqual(launchDefaultValues(config), baseline.current)) {
      applied.current.finish('success');
      applied.current = null;
    }
  }, [config]);
  useEffect(() => () => applied.current?.finish('cancelled'), []);
  const first = useRef(true);
  useEffect(() => {
    const initial = first.current;
    first.current = false;
    const offerId = config.offerId;
    let active = true;
    if (!readFlow.current || readFlow.current.offerId !== offerId)
      readFlow.current = { offerId, id: crypto.randomUUID() };
    const observation = observeLaunchDefaults(
      'read',
      offerId ? 'offer' : 'workspace',
      readFlow.current.id
    );
    setState({ offerId, loading: true, profile: null });
    setProposal(null);
    setBuyerMissing(false);
    // Fresh general defaults are read on each actual selection, not on realtime.
    const request = offerId ? launchApi.defaults(teamId, offerId) : Promise.resolve(null);
    void request
      .then(async profile => {
        if (!active) return;
        const general = !profile
          ? initial && !offerId
            ? latest.current.workspace
            : await launchApi.defaults(teamId)
          : null;
        if (!active) return;
        setState({ offerId, loading: false, profile });
        const nextSource = profile ? 'offer' : general ? 'workspace' : 'builtin';
        const values = resolvedLaunchDefaults(profile ?? general);
        // No reset decision when there is no saved profile, or nothing would change.
        const available: typeof proposal =
          nextSource !== 'builtin' &&
          !launchValuesEqual(launchDefaultValues(latest.current.config), values)
            ? { offerId, values, source: nextSource }
            : null;
        observation.finish('success');
        // Reopening a saved launch is not an offer-selection action.
        if (initial && openedExisting.current) return;
        if (initial && !offerId) return;
        // Every actual selection uses the same explicit decision, including
        // fresh drafts that autosave has already assigned an ID.
        setProposal(available);
      })
      .catch(error => {
        if (!active) return;
        observation.finish('failure', error);
        setState({ offerId, loading: false, profile: null, error });
      });
    return () => {
      active = false;
      observation.finish('cancelled');
    };
  }, [teamId, config.offerId, retry]);
  return {
    ...state,
    loading: state.loading || state.offerId !== config.offerId,
    source: !launchValuesEqual(launchDefaultValues(config), baseline.current)
      ? ('current' as const)
      : source,
    proposal: state.offerId === config.offerId ? proposal : null,
    buyerMissing,
    apply: () => {
      if (proposal && proposal.offerId === latest.current.config.offerId)
        applyRef.current(proposal.values, proposal.source);
    },
    keep: () => {
      setProposal(null);
      setSource('current');
    },
    retry: () => setRetry(value => value + 1),
    reviewed: (profile: Profile, scope: 'offer' | 'workspace') => {
      if (scope === 'offer') setState(old => ({ ...old, profile }));
      setProposal(old => (scope === 'workspace' && old?.source === 'offer' ? old : null));
    },
    saved: (profile: NonNullable<Profile>, scope: 'offer' | 'workspace' = 'offer') => {
      if (scope === 'offer') setState(old => ({ ...old, profile }));
      setProposal(old => (scope === 'workspace' && old?.source === 'offer' ? old : null));
      baseline.current = launchDefaultValues(profile.config);
      setSource(scope);
    }
  };
}
