import path from 'node:path';
import ts from 'typescript';
/** Rewrite only relative import specifiers from a frozen source file. Bare
 * packages keep current installed dependencies; source bytes/digests are kept. */
export function rewriteFixtureImports(source, originalFile) {
  const file = ts.createSourceFile(
    originalFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const edits = [];
  function capture(literal) {
    if (!literal || !ts.isStringLiteral(literal) || !literal.text.startsWith('.')) return;
    const start = literal.getStart(file) + 1,
      end = literal.getEnd() - 1,
      quote = source[start - 1];
    const absolute = path.resolve(path.dirname(originalFile), literal.text).replaceAll('\\', '/');
    edits.push({
      start,
      end,
      value: absolute.replaceAll('\\', '\\\\').replaceAll(quote, '\\' + quote)
    });
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) capture(node.moduleSpecifier);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      capture(node.arguments[0]);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      capture(node.argument.literal);
    ts.forEachChild(node, visit);
  }
  visit(file);
  for (const edit of edits.sort((a, b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  return source;
}

export function percentile(samples, percent) {
  if (
    !samples.length ||
    samples.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)
  )
    return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)] ?? null;
}
/** A double RAF alone never verifies latency. Require marks, a renderer Paint
 * correlated to this page frame, a later DrawFrame, and a retained screenshot. */
/** @param {any[]} events @param {any[]} samples @param {string} frameId */
export function verifyPaintSamples(events, samples, frameId) {
  return samples.map(sample => {
    const mark = suffix =>
      events.find(e => e.name === `a26:${sample.id}:${suffix}` && typeof e.ts === 'number');
    const input = mark('input'),
      state = mark('state'),
      boundary = mark('boundary'),
      capture = mark('screenshot');
    if (
      !input ||
      !state ||
      !boundary ||
      !capture ||
      sample.domVerified !== true ||
      typeof sample.screenshot !== 'string' ||
      !sample.screenshot
    )
      return {
        ...sample,
        verified: false,
        latencyMs: null,
        reason: 'missing_input_state_frame_or_screenshot'
      };
    if (input.ts > state.ts || state.ts > boundary.ts || boundary.ts > capture.ts)
      return { ...sample, verified: false, latencyMs: null, reason: 'invalid_mark_order' };
    const paint = events
      .filter(
        e =>
          e.name === 'Paint' &&
          e.ts >= state.ts &&
          e.ts <= capture.ts &&
          e.args?.data?.frame === frameId
      )
      .sort((a, b) => a.ts - b.ts)[0];
    const draw =
      paint &&
      events
        .filter(
          e =>
            e.name === 'DrawFrame' &&
            e.ts >= paint.ts + (typeof paint.dur === 'number' ? paint.dur : 0) &&
            e.ts <= capture.ts
        )
        .sort((a, b) => a.ts - b.ts)[0];
    if (!paint || !draw || draw.ts < input.ts)
      return {
        ...sample,
        verified: false,
        latencyMs: null,
        reason: 'no_correlated_renderer_paint_and_draw_frame'
      };
    return {
      ...sample,
      verified: true,
      latencyMs: (draw.ts - input.ts) / 1000,
      proof: {
        inputTs: input.ts,
        stateTs: state.ts,
        paintTs: paint.ts,
        drawFrameTs: draw.ts,
        boundaryTs: boundary.ts,
        screenshotMarkTs: capture.ts,
        pageFrameId: frameId,
        boundary: 'renderer_draw_frame_not_physical_monitor_presentation'
      }
    };
  });
}
