import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap(name => {
    const path = join(root, name);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(tsx?|html)$/.test(path)
        ? [path]
        : [];
  });
}

describe('Soty customer-facing brand', () => {
  it('contains no Wishly customer copy', () => {
    for (const file of sourceFiles('apps/soty-review/src'))
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/Wishly/);
  });

  it('uses the current shared Soty header logo without reconstructing it in UI code', () => {
    const logo = readFileSync('apps/soty-review/src/components/SotyLogo.tsx', 'utf8');
    expect(logo).toContain("import sotyLogoLight from '../assets/soty-header-logo-light.svg'");
    expect(logo).toContain("import sotyLogoDark from '../assets/soty-header-logo-dark.svg'");
    expect(logo).toContain('className="soty-logo-image soty-logo-image-light"');
    expect(existsSync('apps/soty-review/src/assets/soty-logo.png')).toBe(false);
    expect(existsSync('apps/soty-review/src/assets/soty-header-logo-light.svg')).toBe(true);
    expect(existsSync('apps/soty-review/src/assets/soty-header-logo-dark.svg')).toBe(true);
  });

  it('keeps the header logo within the shared compact header footprint', () => {
    const styles = readFileSync('apps/soty-review/src/styles.css', 'utf8');
    expect(styles).toMatch(/\.soty-brand-button\s*\{[^}]*height: 68px/s);
    expect(styles).toMatch(/\.soty-logo\s*\{[^}]*position: absolute/s);
    expect(styles).toMatch(/\.soty-logo-image\s*\{[^}]*height: 55\.2px/s);
  });
});
