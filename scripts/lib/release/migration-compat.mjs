/**
 * Whether a migration can be applied while the previous client is still running.
 *
 * Every release applies its database changes before the new browser bundle and
 * the new desktop app reach anyone — that ordering is deliberate, and it is also
 * the reason this check exists. For a few minutes, and for desktop users for
 * days, the database is newer than the code talking to it. A migration that
 * removes something the released client still reads does not fail at deploy
 * time; it fails for users, quietly, one feature at a time.
 *
 * The plan already carries the author's `compatibleWithPrevious` declaration.
 * This is the machine checking the declaration, because the failure it prevents
 * is invisible until somebody complains.
 *
 * Deliberately conservative and deliberately narrow: it reads SQL, not
 * intentions, so it reports statements that are *capable* of breaking a client
 * and leaves the judgement to whoever reads the blocker.
 */

/** `--` to end of line and `/* *\/` blocks, so a commented-out drop is not a drop. */
export function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/--[^\n]*/gu, ' ');
}

const OBJECT = String.raw`(?:if\s+exists\s+)?([a-z_][\w$]*(?:\.[a-z_][\w$]*)?)`;
/**
 * A drop only counts when it starts a statement.
 *
 * `alter publication supabase_realtime drop table public.team_tasks` removes a
 * table from the realtime publication and leaves the table exactly where it was.
 * Two migrations here do that, and without this anchor both were reported as
 * dropping a table that is still in the database — the kind of false alarm that
 * teaches people to skip the blocker.
 */
const STATEMENT_START = String.raw`(?:^|;)\s*`;

/**
 * Objects this migration removes, and objects it creates, by bare name.
 *
 * The distinction matters because the overwhelmingly common shape in this
 * repository is `drop function if exists f(...)` immediately followed by
 * `create function f(...)` — the standard way to redefine a function whose
 * signature changed. Fourteen of the migrations here do it. A check that called
 * that a removal would be wrong fourteen times out of fourteen, and a check
 * that is usually wrong gets switched off.
 */
export function droppedAndCreated(sql) {
  const text = stripComments(sql).toLowerCase();
  const dropped = new Map();
  const created = new Set();

  for (const [kind, pattern] of [
    ['function', new RegExp(String.raw`${STATEMENT_START}drop\s+function\s+${OBJECT}`, 'gu')],
    ['table', new RegExp(String.raw`${STATEMENT_START}drop\s+table\s+${OBJECT}`, 'gu')],
    ['view', new RegExp(String.raw`${STATEMENT_START}drop\s+(?:materialized\s+)?view\s+${OBJECT}`, 'gu')],
    ['trigger', new RegExp(String.raw`${STATEMENT_START}drop\s+trigger\s+${OBJECT}`, 'gu')],
    ['type', new RegExp(String.raw`${STATEMENT_START}drop\s+type\s+${OBJECT}`, 'gu')]
  ])
    for (const match of text.matchAll(pattern)) dropped.set(`${kind}:${match[1]}`, match[1]);

  for (const [kind, pattern] of [
    ['function', /\bcreate\s+(?:or\s+replace\s+)?function\s+([a-z_][\w$]*(?:\.[a-z_][\w$]*)?)/gu],
    ['table', /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][\w$]*(?:\.[a-z_][\w$]*)?)/gu],
    ['view', /\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+([a-z_][\w$]*(?:\.[a-z_][\w$]*)?)/gu],
    ['trigger', /\bcreate\s+(?:or\s+replace\s+)?trigger\s+([a-z_][\w$]*(?:\.[a-z_][\w$]*)?)/gu],
    ['type', /\bcreate\s+type\s+([a-z_][\w$]*(?:\.[a-z_][\w$]*)?)/gu]
  ])
    for (const match of text.matchAll(pattern)) created.add(`${kind}:${match[1]}`);

  return { dropped, created };
}

/**
 * @param {string} sql one migration file
 * @returns {{reason: string}[]} empty when nothing in it can break a running client
 */
export function clientBreakingStatements(sql) {
  const text = stripComments(sql).toLowerCase();
  const problems = [];
  const { dropped, created } = droppedAndCreated(sql);

  for (const [key, name] of dropped) {
    if (created.has(key)) continue; // redefinition, not removal
    const kind = key.split(':')[0];
    problems.push({ reason: `drops ${kind} ${name} without recreating it` });
  }

  // A column that disappears, is renamed, or changes type takes every query
  // naming it with it — including the ones running in an app somebody has not
  // updated yet.
  for (const match of text.matchAll(/\balter\s+table\s+(?:if\s+exists\s+)?([\w.$]+)[\s\S]{0,400}?\bdrop\s+column\s+(?:if\s+exists\s+)?([\w$]+)/gu))
    problems.push({ reason: `drops column ${match[2]} from ${match[1]}` });

  for (const match of text.matchAll(/\balter\s+table\s+(?:if\s+exists\s+)?([\w.$]+)[\s\S]{0,400}?\brename\s+(?:column\s+)?([\w$]+)\s+to\s+([\w$]+)/gu))
    problems.push({ reason: `renames ${match[1]}.${match[2]} to ${match[3]}` });

  for (const match of text.matchAll(/\balter\s+table\s+(?:if\s+exists\s+)?([\w.$]+)\s+rename\s+to\s+([\w$]+)/gu))
    problems.push({ reason: `renames table ${match[1]} to ${match[2]}` });

  for (const match of text.matchAll(/\balter\s+column\s+([\w$]+)\s+(?:set\s+data\s+)?type\s+([\w$]+)/gu))
    problems.push({ reason: `changes the type of column ${match[1]} to ${match[2]}` });

  // An insert written by the released client omits the new column, so making it
  // mandatory turns every one of those inserts into an error.
  for (const match of text.matchAll(/\balter\s+column\s+([\w$]+)\s+set\s+not\s+null/gu))
    problems.push({ reason: `makes column ${match[1]} mandatory, which the released client's inserts may omit` });

  return problems;
}

/**
 * @param {readonly {id: string, sql: string}[]} migrations
 * @returns {{id: string, reason: string}[]}
 */
export function incompatibleMigrations(migrations) {
  return migrations.flatMap(migration =>
    clientBreakingStatements(migration.sql).map(problem => ({ id: migration.id, reason: problem.reason }))
  );
}
