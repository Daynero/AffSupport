/** Every error is private JSON, never a partially built workbook. */
export function financeExportErrorResponse(
  cause: unknown,
  headers: Record<string, string>
): Response {
  const message = cause instanceof Error ? cause.message : '';
  const auth = /AUTH_REQUIRED/u.test(message);
  const forbidden = /PERMISSION_DENIED|NOT_A_MEMBER/u.test(message);
  const invalid = cause instanceof SyntaxError || /INVALID_INPUT/u.test(message);
  const limit = /FINANCE_EXPORT_PRECISION|FINANCE_EXPORT_SIZE/u.test(message);
  const code = auth
    ? 'AUTH_REQUIRED'
    : forbidden
      ? 'PERMISSION_DENIED'
      : invalid
        ? 'INVALID_INPUT'
        : 'FINANCE_EXPORT_FAILED';
  return Response.json(
    { ok: false, error: { code, retryable: code === 'FINANCE_EXPORT_FAILED' && !limit } },
    { status: auth ? 401 : forbidden ? 403 : invalid ? 400 : limit ? 409 : 500, headers }
  );
}
