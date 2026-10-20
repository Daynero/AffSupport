import { teamAgentLabel } from '@video-compressor/shared';

/** Plain, consistent identity in operational and financial rows. */
export function AgentIdentity({
  accountName,
  agentId,
  revealed = false
}: {
  accountName: string;
  agentId: string;
  revealed?: boolean;
}) {
  const label = revealed ? agentId : teamAgentLabel(accountName, agentId);
  return (
    <span className="block max-w-full min-w-0 truncate" title={agentId} aria-label={label}>
      {label}
    </span>
  );
}
