import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

// The ownership invariant relies on every interactive session writer participating,
// including future call sites in a different screen. This is an architecture fence.
const methods = new Set([
  'signOut',
  'setSession',
  'exchangeCodeForSession',
  'signInWithPassword',
  'signInWithOAuth',
  'signInWithIdToken',
  'signInWithOtp',
  'verifyOtp',
  'signUp',
  'signInAnonymously',
  'signInWithSSO',
  'signInWithWeb3'
]);
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.[jt]sx?$/u.test(entry.name) ? [path] : [];
  });
}
it('keeps every interactive SDK session mutation inside the shared session lane', () => {
  const violations: string[] = [];
  let inspected = 0;
  for (const file of files('apps/web/src')) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text,
          owner = node.expression.expression;
        if (
          methods.has(method) &&
          ((ts.isPropertyAccessExpression(owner) && owner.name.text === 'auth') ||
            (file.endsWith('/auth/session-mutations.ts') &&
              ts.isIdentifier(owner) &&
              owner.text === 'auth'))
        ) {
          inspected++;
          let fenced = false;
          for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
            if (
              ts.isCallExpression(parent) &&
              ts.isIdentifier(parent.expression) &&
              (['mutateSession', 'runAuthSessionMutation'].includes(parent.expression.text) ||
                (file.endsWith('/auth/session-mutations.ts') &&
                  parent.expression.text === 'withAuthSessionLane'))
            )
              fenced = true;
          }
          if (!fenced)
            violations.push(
              `${relative(process.cwd(), file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}:${method}`
            );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(inspected).toBeGreaterThanOrEqual(6);
  expect(violations).toEqual([]);
});
