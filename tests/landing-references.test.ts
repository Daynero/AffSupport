import { describe, expect, it } from 'vitest';
import {
  isRewritableFile,
  resolveReference,
  rewriteReferences,
  type RenameMap
} from '../apps/agent/src/landing/references.js';

const renames: RenameMap = new Map([
  ['assets/img/hero.jpg', 'assets/img/hero.webp'],
  ['assets/img/Banner.JPG', 'assets/img/Banner.webp'],
  ['assets/img/logo.png', 'assets/img/logo.webp'],
  ['nested/deep/photo 1.jpg', 'nested/deep/photo 1.webp'],
  ['assets/media/promo.mov', 'assets/media/promo.mp4'],
  ['assets/img/Тест.png', 'assets/img/Тест.webp']
]);

describe('landing reference rewriting', () => {
  it('rewrites src/href/srcset/url() and preserves query and hash', () => {
    const html = [
      '<img src="assets/img/hero.jpg?v=2#frag">',
      '<link rel="preload" href="assets/img/hero.jpg">',
      '<img srcset="assets/img/hero.jpg 1x, assets/img/Banner.JPG 2x">',
      '<div style="background-image:url(assets/img/logo.png)"></div>'
    ].join('\n');
    const { text, count } = rewriteReferences(html, 'index.html', renames);
    expect(text).toContain('assets/img/hero.webp?v=2#frag');
    expect(text).toContain('href="assets/img/hero.webp"');
    expect(text).toContain('assets/img/hero.webp 1x, assets/img/Banner.webp 2x');
    expect(text).toContain('url(assets/img/logo.webp)');
    expect(count).toBe(5);
  });

  it('rewrites uppercase extensions but always emits lowercase .webp', () => {
    const { text } = rewriteReferences('url(assets/img/Banner.JPG)', 'index.html', renames);
    expect(text).toBe('url(assets/img/Banner.webp)');
  });

  it('handles URL-encoded and spaced names', () => {
    const html =
      '<img src="assets/img/%D0%A2%D0%B5%D1%81%D1%82.png"><img src="nested/deep/photo%201.jpg">';
    const { text } = rewriteReferences(html, 'index.html', renames);
    expect(text).toContain('assets/img/%D0%A2%D0%B5%D1%81%D1%82.webp');
    expect(text).toContain('nested/deep/photo%201.webp');
  });

  it('resolves ../ paths relative to the referencing file', () => {
    const css = ".hero{background:url('../assets/img/hero.jpg?v=9')}";
    const { text, count } = rewriteReferences(css, 'css/style.css', renames);
    expect(text).toContain("url('../assets/img/hero.webp?v=9')");
    expect(count).toBe(1);
  });

  it('rewrites videos from .mov to .mp4', () => {
    const { text } = rewriteReferences(
      '<source src="assets/media/promo.mov">',
      'index.html',
      renames
    );
    expect(text).toContain('assets/media/promo.mp4');
  });

  it('never touches external, protocol-relative, data or blob URLs', () => {
    const html = [
      '<img src="https://cdn.example.com/hero.jpg">',
      '<img src="//cdn.example.com/logo.png">',
      '<img src="data:image/png;base64,AAAA">'
    ].join('\n');
    const { text, count } = rewriteReferences(html, 'index.html', renames);
    expect(count).toBe(0);
    expect(text).toContain('https://cdn.example.com/hero.jpg');
    expect(text).toContain('//cdn.example.com/logo.png');
    expect(text).toContain('data:image/png;base64,AAAA');
  });

  it('leaves unmapped and preserved assets alone', () => {
    const html = '<img src="assets/img/icon.svg"><img src="assets/img/anim.gif">';
    const { text, count } = rewriteReferences(html, 'index.html', renames);
    expect(count).toBe(0);
    expect(text).toBe(html);
  });

  it('does not confuse identical file names in different folders', () => {
    const map: RenameMap = new Map([['a/pic.jpg', 'a/pic.webp']]);
    const html = '<img src="a/pic.jpg"><img src="b/pic.jpg">';
    const { text } = rewriteReferences(html, 'index.html', map);
    expect(text).toBe('<img src="a/pic.webp"><img src="b/pic.jpg">');
  });

  it('resolves references outside the landing root to null', () => {
    expect(resolveReference('index.html', '../../secret.jpg')).toBeNull();
    expect(resolveReference('css/app.css', '../assets/x.jpg')).toBe('assets/x.jpg');
    expect(resolveReference('index.html', '/assets/x.jpg')).toBe('assets/x.jpg');
  });

  it('recognizes rewritable file types', () => {
    expect(isRewritableFile('index.html')).toBe(true);
    expect(isRewritableFile('css/app.CSS')).toBe(true);
    expect(isRewritableFile('app.js')).toBe(true);
    expect(isRewritableFile('data.json')).toBe(false);
    expect(isRewritableFile('img/a.png')).toBe(false);
  });
});
