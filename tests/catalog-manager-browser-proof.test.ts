import { expect, it } from 'vitest';
import path from 'node:path';
import {
  rewriteFixtureImports,
  verifyPaintSamples,
  percentile
} from '../scripts/lib/catalog-manager-browser-proof.mjs';
it('freezes only relative import paths into the current common graph', () => {
  const text =
    "/* from './untouched-comment' */ const label=\"import './untouched-label'\"; import {x} from './x'; import type{Y}from'../y'; import 'react'; import './style.css'; const y=import('./lazy');";
  const root = path.resolve('external', 'repo').replaceAll('\\', '/');
  const actual = rewriteFixtureImports(text, `${root}/ui/Dialog.tsx`);
  expect(actual).toContain("from './untouched-comment'");
  expect(actual).toContain("import './untouched-label'");
  expect(actual).toContain(`from '${root}/ui/x'`);
  expect(actual).toContain(`from'${root}/y'`);
  expect(actual).toContain("import 'react'");
  expect(actual).toContain(`import '${root}/ui/style.css'`);
  expect(actual).toContain(`import('${root}/ui/lazy')`);
});
it('never converts double RAF alone into a measured paint sample', () => {
  const marks = [
    { name: 'a26:s:input', ts: 1000 },
    { name: 'a26:s:state', ts: 2000 },
    { name: 'a26:s:boundary', ts: 5000 },
    { name: 'a26:s:screenshot', ts: 6000 }
  ];
  const sample = { id: 's', domVerified: true, screenshot: 'retained.png' };
  expect(verifyPaintSamples(marks, [sample], 'frame')[0]).toMatchObject({
    verified: false,
    latencyMs: null
  });
  const events = [
    ...marks,
    { name: 'Paint', ts: 3000, args: { data: { frame: 'other' } } },
    { name: 'DrawFrame', ts: 4000 }
  ];
  expect(verifyPaintSamples(events, [sample], 'frame')[0].verified).toBe(false);
  events.push({ name: 'Paint', ts: 2500, args: { data: { frame: 'frame' } } });
  expect(verifyPaintSamples(events, [sample], 'frame')[0]).toMatchObject({
    verified: true,
    latencyMs: 3
  });
  expect(verifyPaintSamples(events, [{ ...sample, screenshot: null }], 'frame')[0].verified).toBe(
    false
  );
});
it('keeps missing samples unknown and uses nearest-rank actual percentiles', () => {
  expect(percentile([], 95)).toBeNull();
  expect(percentile([0, Number.NaN], 95)).toBeNull();
  expect(
    percentile(
      Array.from({ length: 50 }, (_, i) => i + 1),
      95
    )
  ).toBe(48);
});
