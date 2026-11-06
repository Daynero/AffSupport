/** Closed outcomes for bounded image preparation; limits never mean the whole pool is broken. */
export const RESTITCH_RECOVERY_ERROR_CODES = [
  'RESTITCH_SCREEN_CANDIDATES_EXHAUSTED',
  'RESTITCH_SCREEN_PREVIOUS_FAILURES',
  'RESTITCH_SCREEN_BYTE_LIMIT',
  'RESTITCH_SCREEN_IO_LIMIT',
  'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
] as const;
export type RestitchRecoveryErrorCode = (typeof RESTITCH_RECOVERY_ERROR_CODES)[number];
