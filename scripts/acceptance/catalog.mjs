import { readFileSync } from 'node:fs';
const source = readFileSync(
  new URL('../../specs/036-production-acceptance/manual-test-cases.md', import.meta.url),
  'utf8'
);
export const CASE_IDS = Object.freeze(
  [...source.matchAll(/^\|\s*([A-Z]+-\d{3})\s*\|/gm)].map(match => match[1])
);
if (CASE_IDS.length !== 174 || new Set(CASE_IDS).size !== 174)
  throw new Error('ACCEPTANCE_CATALOG_INVALID');
