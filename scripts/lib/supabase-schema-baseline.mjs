/**
 * Dropping public also drops its schema-scoped default ACLs. Preserve those
 * schema definitions before replaying application migrations, without rows or
 * role passwords. Global defaults survive the drop and must not be duplicated.
 * @param {string} schemaDump
 */
export function publicDefaultPrivileges(schemaDump) {
  const lines = schemaDump
    .split(/\r?\n/u)
    .filter(line => /^ALTER DEFAULT PRIVILEGES .* IN SCHEMA (?:public|"public") /u.test(line));
  if (
    lines.some(
      line =>
        !/^ALTER DEFAULT PRIVILEGES FOR ROLE (?:[a-zA-Z_][\w$]*|"(?:[^";]|"")+") IN SCHEMA (?:public|"public") (?:GRANT|REVOKE) [^;\r\n]+;$/u.test(
          line
        )
    )
  )
    throw new Error('PUBLIC_DEFAULT_PRIVILEGES_UNSUPPORTED');
  return lines.join('\n');
}

/** @param {string} schemaDump */
export function resetApplicationSchemas(schemaDump) {
  const defaults = publicDefaultPrivileges(schemaDump);
  return (
    'drop schema if exists private cascade; drop schema public cascade; create schema public authorization postgres; grant usage on schema public to public; grant all on schema public to postgres; delete from cron.job;\n' +
    defaults
  );
}

/**
 * Column options PostgreSQL itself accepts in `ALTER COLUMN ... SET (...)`
 * (attribute_reloptions). Both are planner statistics hints only.
 */
const COLUMN_OPTIONS = new Set(['n_distinct', 'n_distinct_inherited']);
const COLUMN_OPTION_STATEMENT =
  /^(ALTER TABLE ONLY .+ ALTER COLUMN .+ SET \()([a-z_][a-z0-9_]*=[^,()'"\s]+(?:, [a-z_][a-z0-9_]*=[^,()'"\s]+)*)(\);)$/u;

/**
 * The local stack's data directory can outlive the image that wrote it: a
 * newer Supabase PostgreSQL build stamps every column it creates with a
 * private `pg_attver=<n>` attribute option, pg_dump faithfully emits it, and
 * the pinned image the disposable container runs rejects it as an
 * "unrecognized parameter" before a single test starts. Such an option holds
 * no schema meaning, so only options outside PostgreSQL's own list are
 * removed, a statement is dropped only when nothing it sets remains, and every
 * other line, including any statement this pattern cannot parse, reaches the
 * server unchanged and fails loudly if it is wrong.
 * @param {string} schemaDump
 * @returns {{ dump: string, dropped: Map<string, number> }}
 */
export function withoutUnknownColumnOptions(schemaDump) {
  /** @type {Map<string, number>} */
  const dropped = new Map();
  const dump = schemaDump
    .split(/(?<=\n)/u)
    .flatMap(line => {
      const ending = /\r?\n$/u.exec(line)?.[0] ?? '';
      const match = COLUMN_OPTION_STATEMENT.exec(line.slice(0, line.length - ending.length));
      if (!match) return [line];
      const options = match[2].split(', ');
      const kept = options.filter(option => COLUMN_OPTIONS.has(option.split('=')[0]));
      if (kept.length === options.length) return [line];
      for (const option of options) {
        const name = option.split('=')[0];
        if (!COLUMN_OPTIONS.has(name)) dropped.set(name, (dropped.get(name) ?? 0) + 1);
      }
      return kept.length ? [match[1] + kept.join(', ') + match[3] + ending] : [];
    })
    .join('');
  return { dump, dropped };
}
