import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { platformFromUserAgent } from '../apps/web/src/lib/platform.js';

/**
 * A rollout you cannot measure is a rollout you cannot manage. These tests hold
 * the two things the Windows launch depends on afterwards: every analytics event
 * carries the platform it came from (so Windows adoption and failure rates are
 * separable from macOS), and the people already waiting for Windows can be
 * identified when it ships.
 */
const analytics = readFileSync('apps/web/src/analytics/service.ts', 'utf8');
const events = readFileSync('apps/web/src/analytics/events.ts', 'utf8');
const waitlistMigration = readFileSync(
  'supabase/migrations/20260816130000_windows_app_waitlist.sql',
  'utf8'
);
const adminPage = readFileSync('apps/web/src/pages/AdminPage.tsx', 'utf8');

describe('platform attribution', () => {
  it('stamps every analytics event with the visitor platform', () => {
    expect(analytics).toMatch(/platform: currentBrowserPlatform\(\)/u);
    expect(analytics).toMatch(/architecture: broadArchitecture\(\)/u);
  });

  it('classifies a Windows visitor as windows, so cohorts separate cleanly', () => {
    expect(platformFromUserAgent('Win32 Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(
      'windows'
    );
    expect(platformFromUserAgent('MacIntel Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(
      'macos'
    );
  });

  it('tracks the download click that starts an install', () => {
    expect(events).toContain("'install_download_clicked'");
  });

  it('tracks a blocked Windows download while the build is unpublished', () => {
    // The waitlist path records the demand that justifies the rollout.
    expect(events).toContain("'blocked_action_attempted'");
  });
});

describe('Windows waitlist', () => {
  it('stores who asked to be told, with their email', () => {
    expect(waitlistMigration).toMatch(/create table public\.windows_app_waitlist/u);
    expect(waitlistMigration).toMatch(/email text not null/u);
  });

  it('exposes an admin-only way to list them when the build ships', () => {
    expect(waitlistMigration).toMatch(/function public\.admin_list_windows_app_waitlist/u);
    expect(waitlistMigration).toMatch(/if not public\.is_admin\(\) then/u);
    expect(adminPage).toContain('admin_list_windows_app_waitlist');
  });

  it('keeps the table itself unreadable by clients, per least privilege', () => {
    expect(waitlistMigration).toMatch(/enable row level security/u);
    expect(waitlistMigration).toMatch(
      /revoke all on table public\.windows_app_waitlist from public, anon, authenticated/u
    );
  });

  it('keeps both functions search_path-pinned security definers', () => {
    const definers = waitlistMigration.match(/security definer/gu) ?? [];
    const pinned = waitlistMigration.match(/set search_path = ''/gu) ?? [];
    expect(definers.length).toBeGreaterThanOrEqual(2);
    expect(pinned.length).toBe(definers.length);
  });
});
