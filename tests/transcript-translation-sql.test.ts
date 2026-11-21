import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 063: what the translation migrations promise, read from the files. pgTAP proves the behaviour
 * on a real database; this keeps the shape from drifting where a reviewer would not look.
 */

const allowance = readFileSync(
  'supabase/migrations/20261222110000_ai_allowance_and_usage.sql',
  'utf8'
);
const translations = readFileSync(
  'supabase/migrations/20261222111000_transcript_translations.sql',
  'utf8'
);
const analytics = readFileSync('supabase/migrations/20261222113000_ai_usage_analytics.sql', 'utf8');
const all = [allowance, translations, analytics].join('\n');

function functions(sql: string): string[] {
  return [...sql.matchAll(/create function ([a-z_.]+)\(/gu)].map(match => match[1]!);
}

describe('063 migrations', () => {
  it('keeps every table private, row-secured and closed to clients', () => {
    for (const table of [
      'private.ai_feature_allowances',
      'private.ai_allowance_reservations',
      'private.ai_usage_events',
      'private.transcript_translations'
    ]) {
      expect(all).toContain(`create table ${table} (`);
      expect(all).toContain(`alter table ${table} enable row level security;`);
      expect(all).toContain(`alter table ${table} force row level security;`);
    }
    expect(all).not.toMatch(/create policy/iu);
  });

  it('pins search_path on every function', () => {
    for (const sql of [allowance, translations]) {
      const bodies = sql.split(/create function /u).slice(1);
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) expect(body.slice(0, 600)).toContain("set search_path = ''");
    }
  });

  it('lets clients read only through the four public readers; writes are service-only', () => {
    const granted = [
      ...all.matchAll(/grant execute on function ([a-z_.]+)\([^)]*\) to ([a-z_, ]+);/gu)
    ];
    for (const [, name, roles] of granted) {
      if (roles!.includes('authenticated')) {
        expect([
          'public.ai_allowance_status',
          'public.list_video_translations',
          'public.list_personal_translations',
          'public.get_transcript_translation'
        ]).toContain(name);
      }
      if (name!.startsWith('public.service_')) expect(roles!.trim()).toBe('service_role');
    }
    for (const name of functions(all).filter(name => name.startsWith('public.service_'))) {
      expect(all).toMatch(new RegExp(`revoke all on function ${name.replace('.', '\\.')}\\(`, 'u'));
    }
  });

  it('fences attachment cleanup on the table that references team materials', () => {
    expect(translations).toContain('references public.team_materials (id) on delete cascade');
    expect(translations).toMatch(
      /create trigger task_cleanup_reference_fence before insert or update on private\.transcript_translations/u
    );
  });

  it('checks the space view right on every reader and keeps failed attempts personal', () => {
    expect(translations).toMatch(
      /list_video_translations[\s\S]*private\.can\(p_team, 'view', auth\.uid\(\)\)/u
    );
    expect(translations).toMatch(
      /get_transcript_translation[\s\S]*private\.can\(r\.team_id, 'view', auth\.uid\(\)\)/u
    );
    expect(translations).toMatch(/status = 'failed' and rank = 1 and requested_by = p_viewer/u);
  });

  it('reserves under one lock and lets a stale hold stop counting', () => {
    expect(allowance).toMatch(/pg_advisory_xact_lock\(hashtextextended\('ai_allowance:'/u);
    expect(allowance).toContain("interval '6 minutes'");
    expect(translations).toContain("interval '5 minutes'");
    expect(allowance).toContain("('transcript_translation', 9000)");
  });

  it('never exposes text or fingerprints to analytics', () => {
    const code = analytics.replace(/--.*$/gmu, '');
    expect(code).not.toMatch(/\bsegments\b|source_fingerprint|document_key/u);
    expect(analytics).toContain('to wishly_analytics_ro');
  });

  it('raises business refusals with PT409 so PostgREST never retries them', () => {
    for (const match of all.matchAll(/raise exception '([A-Z_]+)'([^;]*);/gu)) {
      expect(match[2]).toContain("errcode = 'PT409'");
    }
  });
});
