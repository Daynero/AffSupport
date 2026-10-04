import { teamAgentLabel } from '@video-compressor/shared';
import { Marked } from './Marked';

/** The same scannable identity in operational and financial rows. */
export function AgentIdentity({
  accountName,
  agentId,
  revealed = false,
  search = ''
}: {
  accountName: string;
  agentId: string;
  revealed?: boolean;
  search?: string;
}) {
  const label = revealed ? agentId : teamAgentLabel(accountName, agentId);
  const suffix = agentId.slice(-3);
  const prefix = label.endsWith(suffix) ? label.slice(0, -suffix.length) : label;
  return (
    <span
      className="inline-flex max-w-full min-w-0 items-center gap-1"
      title={agentId}
      aria-label={label}
    >
      <span className="min-w-0 truncate">
        <Marked text={prefix} term={search} />
      </span>
      <span className="team-agent-tail shrink-0 rounded-sm px-1 font-semibold">
        <Marked text={suffix} term={search} />
      </span>
    </span>
  );
}
