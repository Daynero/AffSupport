// The Windows half of "find the dropped original on disk": where the user's
// folders really are (OneDrive moves them) and how the file index is asked.
// Both are pure builders here; PowerShell itself runs only on Windows.
import { describe, expect, it } from 'vitest';
import {
  mergeWindowsContentFolders,
  windowsSearchSql
} from '../apps/agent/src/platform/platform.js';

describe('mergeWindowsContentFolders', () => {
  it('puts the folders Windows reported first, then the defaults, then every OneDrive root', () => {
    const folders = mergeWindowsContentFolders(
      'C:\\Users\\Ada',
      ['C:\\Users\\Ada\\Downloads', 'C:\\Users\\Ada\\OneDrive\\Desktop'],
      {
        OneDrive: 'C:\\Users\\Ada\\OneDrive',
        OneDriveCommercial: 'C:\\Users\\Ada\\OneDrive - Acme'
      }
    );
    expect(folders.slice(0, 2)).toEqual([
      'C:\\Users\\Ada\\Downloads',
      'C:\\Users\\Ada\\OneDrive\\Desktop'
    ]);
    expect(folders).toContain('C:\\Users\\Ada\\Desktop');
    expect(folders).toContain('C:\\Users\\Ada\\Videos');
    expect(folders).toContain('C:\\Users\\Ada\\OneDrive\\Videos');
    expect(folders).toContain('C:\\Users\\Ada\\OneDrive - Acme\\Documents');
  });

  it('drops duplicates whatever their case or separators, and anything not absolute', () => {
    const folders = mergeWindowsContentFolders(
      'C:\\Users\\Ada',
      ['c:/users/ada/downloads', 'Downloads', ''],
      {}
    );
    expect(folders.filter(folder => /downloads$/iu.test(folder))).toHaveLength(1);
    expect(folders.every(folder => /^[a-z]:\\/iu.test(folder))).toBe(true);
  });
});

describe('windowsSearchSql', () => {
  it('asks for the exact file name with its quotes doubled', () => {
    expect(windowsSearchSql("Ada's clip.mp4")).toBe(
      "SELECT TOP 50 System.ItemPathDisplay FROM SYSTEMINDEX WHERE System.FileName = 'Ada''s clip.mp4'"
    );
  });
});
