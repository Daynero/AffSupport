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
