import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_CAPABILITIES } from '../packages/shared/src/types.js';

describe('Wishly Finder image conversion integration', () => {
  const extension = readFileSync('packaging/FinderExtension/FinderSync.swift', 'utf8');
  const launcher = readFileSync('packaging/Launcher.swift', 'utf8');
  // The native bridge is split between the server factory (auth preHandler)
  // and the media-actions route module.
  const agent = [
    readFileSync('apps/agent/src/server/app.ts', 'utf8'),
    readFileSync('apps/agent/src/media-actions/routes.ts', 'utf8')
  ].join('\n');
  const plist = readFileSync('packaging/Info.plist', 'utf8');

  it('offers a focused three-format submenu without a HEIC output', () => {
    const targetFormat = extension.slice(
      extension.indexOf('private enum TargetFormat'),
      extension.indexOf('private struct FinderActionPayload')
    );
    expect(targetFormat).toContain('case png');
    expect(targetFormat).toContain('case jpeg');
    expect(targetFormat).toContain('case webp');
    expect(targetFormat).not.toMatch(/\bheic\b|\bheif\b/i);
    expect(extension).toContain('rootItem.submenu = targetMenu');
    expect(extension).toContain('targetMenu.autoenablesItems = false');
    expect(extension).toContain('menuKind == .contextualMenuForItems');
    expect(extension).toContain('kind: "image-conversion"');
    expect(extension).toContain('item.tag = format.menuTag');
    expect(extension).toContain('menuPathsByFormat = pathsByFormat');
    expect(extension).not.toContain('item.representedObject');
    const actionHandler = extension.slice(
      extension.indexOf('@objc private func convertSelectedImages'),
      extension.indexOf('private func selectedImageURLs')
    );
    expect(actionHandler).not.toContain('selectedImageURLs()');
    expect(launcher).toContain('payload.kind == "image-conversion"');
    expect(
      readFileSync('packaging/FinderExtension/uk.lproj/Localizable.strings', 'utf8')
    ).toContain('"Конвертувати в"');
  });

  it('uses a private authenticated service bridge instead of exposing filesystem writes', () => {
    expect(plist).toContain('<string>com.wishly.finder-action</string>');
    expect(plist).toContain('<string>Soty Finder Action</string>');
    expect(launcher).toContain('"AGENT_NATIVE_TOKEN": nativeToken');
    expect(launcher).toContain('"X-Wishly-Native-Token"');
    expect(agent).toContain("request.url.startsWith('/native/')");
    expect(agent).toContain("'/native/media-actions/images/convert'");
    expect(agent).toContain("app.get('/native/media-actions'");
    expect(agent).toContain("'/native/media-actions/:id'");
    for (const key of [
      'NSDesktopFolderUsageDescription',
      'NSDocumentsFolderUsageDescription',
      'NSDownloadsFolderUsageDescription',
      'NSNetworkVolumesUsageDescription',
      'NSRemovableVolumesUsageDescription'
    ]) {
      expect(plist).toContain(`<key>${key}</key>`);
    }
  });

  it('packages an isolated Finder extension in both app variants', () => {
    const production = readFileSync('scripts/package-mac.sh', 'utf8');
    const development = readFileSync('scripts/package-dev-mac.sh', 'utf8');
    for (const script of [production, development]) {
      expect(script).toContain('scripts/build-finder-extension.sh');
      expect(script).toContain('-framework FinderSync');
      expect(script).toContain('-target arm64-apple-macos13.0');
      expect(script).toContain('--preserve-metadata=entitlements');
    }
    expect(production).toContain('local.video.compressor.test.finder-extension');
    expect(development).toContain('com.wishly.dev.finder-extension');
    expect(development).toContain('Soty Dev Finder Action');
    expect(development).toContain('— Soty Dev');
    expect(development).toContain('Contents/MacOS/WishlyDevAgent');
  });

  it('advertises the native capability for future media-action expansion', () => {
    expect(AGENT_CAPABILITIES).toContain('finder-image-conversion');
  });
});
