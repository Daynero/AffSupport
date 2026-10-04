import {
  parseFinanceSnapshot,
  financeRecord,
  validFinanceDate,
  validFinanceTimezone
} from '../../../packages/shared/dist/team/agent-finance.js';
import { buildFinanceWorkbook } from '../_shared/finance-workbook.ts';

export interface FinanceExportClient {
  rpc(
    name: string,
    args: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}
export async function executeFinanceExport(input: unknown, client: FinanceExportClient) {
  if (
    !financeRecord(input) ||
    typeof input.teamId !== 'string' ||
    !/^[0-9a-f-]{36}$/iu.test(input.teamId) ||
    !validFinanceDate(input.from) ||
    !validFinanceDate(input.to) ||
    !validFinanceTimezone(input.timezone)
  )
    throw new Error('INVALID_INPUT');
  const args = {
    p_team: input.teamId,
    p_from: input.from,
    p_to: input.to,
    p_timezone: input.timezone
  };
  const { data, error } = await client.rpc('get_team_agent_finance', args);
  if (error) throw new Error(error.message);
  const snapshot = parseFinanceSnapshot(data);
  if (
    !snapshot ||
    snapshot.teamId !== input.teamId ||
    snapshot.from !== input.from ||
    snapshot.to !== input.to
  )
    throw new Error('INVALID_RESPONSE');
  const bytes = await buildFinanceWorkbook(snapshot);
  // Recheck access after potentially expensive serialization, without rereading
  // the report: every worksheet must describe the very same snapshot.
  const access = await client.rpc('list_team_agent_finance_legacy', { p_team: input.teamId });
  if (access.error) throw new Error(access.error.message);
  return { bytes, filename: `finance-${snapshot.teamId}-${snapshot.from}-${snapshot.to}.xlsx` };
}
