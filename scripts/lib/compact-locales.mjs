import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const COMPACT_LOCALE_KEYS_ID = '\0soty:compact-locale-keys';
const REQUEST = 'soty:compact-locale-keys';
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** @returns {never} */
function invalid() {
  throw new Error('Locale compression requires matching static string dictionaries.');
}

/** @param {import('typescript').Expression} expression
 * @returns {string} */
function staticString(expression) {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isParenthesizedExpression(expression)) return staticString(expression.expression);
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  )
    return staticString(expression.left) + staticString(expression.right);
  return invalid();
}

/** @param {string} source @param {'en'|'uk'} name */
function dictionary(source, name) {
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) invalid();
  const parsed =
    /** @type {import('typescript').SourceFile & {parseDiagnostics?: readonly import('typescript').Diagnostic[]}} */ (
      ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    );
  if (parsed.parseDiagnostics?.length) invalid();
  /** @type {Array<[string,string]>} */
  const entries = [];
  let declarations = 0;
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const) ||
      statement.modifiers?.length !== 1 ||
      statement.modifiers[0].kind !== ts.SyntaxKind.ExportKeyword ||
      statement.declarationList.declarations.length !== 1
    )
      invalid();
    const declaration = statement.declarationList.declarations[0];
    if (
      !ts.isIdentifier(declaration.name) ||
      declaration.name.text !== name ||
      !declaration.initializer
    )
      invalid();
    let expression = declaration.initializer;
    while (
      ts.isAsExpression(expression) ||
      ts.isParenthesizedExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    )
      expression = expression.expression;
    if (!ts.isObjectLiteralExpression(expression) || ++declarations !== 1) invalid();
    const seen = new Set();
    for (const property of expression.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      )
        invalid();
      const key = property.name.text;
      if (
        seen.has(key) ||
        ['__proto__', 'constructor', 'prototype'].includes(key) ||
        /^(?:0|[1-9][0-9]*)$/u.test(key)
      )
        invalid();
      seen.add(key);
      entries.push([key, staticString(property.initializer)]);
    }
  }
  if (declarations !== 1 || entries.length === 0) invalid();
  return entries;
}

/** Build-only data representation. No source evaluation or translation removal.
 * @param {string} english @param {string} ukrainian */
export function compactLocaleSources(english, ukrainian) {
  const en = dictionary(english, 'en'),
    uk = dictionary(ukrainian, 'uk');
  if (en.length !== uk.length || en.some(([key], index) => key !== uk[index][0])) invalid();
  const keys = en.map(([key]) => key);
  const module = (name, entries) =>
    `import{keys}from${JSON.stringify(REQUEST)};const values=${JSON.stringify(entries.map(([, value]) => value))};export const ${name}={};for(let i=0;i<keys.length;i++)Object.defineProperty(${name},keys[i],{value:values[i],enumerable:true,configurable:true,writable:true});`;
  return {
    keys: `export const keys=${JSON.stringify(keys)};`,
    en: module('en', en),
    uk: module('uk', uk)
  };
}

/** Retain typed authoring files and dev modules; transform only exact build inputs.
 * @returns {import('vite').Plugin} */
export function compactLocalesPlugin() {
  let root = '';
  let english = '',
    ukrainian = '';
  /** @type {ReturnType<typeof compactLocaleSources> | null} */
  let compact = null;
  return {
    name: 'soty-compact-locale-data',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      root = config.root;
    },
    buildStart() {
      const en = path.resolve(root, 'src/locales/en.ts'),
        uk = path.resolve(root, 'src/locales/uk.ts');
      this.addWatchFile(en);
      this.addWatchFile(uk);
      english = readFileSync(en, 'utf8');
      ukrainian = readFileSync(uk, 'utf8');
      compact = compactLocaleSources(english, ukrainian);
    },
    resolveId(id) {
      return id === REQUEST ? COMPACT_LOCALE_KEYS_ID : null;
    },
    load(id) {
      return id === COMPACT_LOCALE_KEYS_ID ? (compact?.keys ?? invalid()) : null;
    },
    transform(code, id) {
      const language =
        id === path.resolve(root, 'src/locales/en.ts').replaceAll('\\', '/')
          ? 'en'
          : id === path.resolve(root, 'src/locales/uk.ts').replaceAll('\\', '/')
            ? 'uk'
            : null;
      if (!language) return null;
      if (!compact || code !== (language === 'en' ? english : ukrainian)) invalid();
      return { code: compact[language], map: null };
    }
  };
}
