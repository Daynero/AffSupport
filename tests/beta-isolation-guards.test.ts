import { describe, expect, it, vi } from 'vitest';
import { executeInvitationCommand } from '../supabase/functions/team-invitations/handler';
import {
  BETA_AGENT_ORIGIN,
  BETA_PROFILE,
  BETA_SITE_ORIGIN,
  evaluateBetaEnvironment,
  evaluateResetTarget,
  type BetaGuardCode
} from '@video-compressor/shared';

/**
 * A valid beta profile. Every test below starts from this and breaks exactly
 * one thing, so a failure names the rule that broke rather than a soup of
 * unrelated problems.
 */
const VALID = {
  VITE_APP_ENVIRONMENT: 'beta',
  SOTY_ENVIRONMENT: 'beta',
  VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_local_development_key',
  VITE_SITE_URL: BETA_SITE_ORIGIN,
  VITE_AGENT_URL: BETA_AGENT_ORIGIN,
  AGENT_PORT: String(BETA_PROFILE.agentPort),
  PUBLIC_SITE_ORIGIN: BETA_AGENT_ORIGIN,
  DEV_SITE_ORIGIN: BETA_SITE_ORIGIN,
  AGENT_SUPPORT_DIRECTORY_NAME: BETA_PROFILE.supportDirectoryName,
  AGENT_ENTITLEMENT_PUBLIC_KEY: 'beta-public-key',
  VITE_LOCAL_DEV_AUTH: 'false',
  VITE_ANALYTICS_ENABLED: 'false',
  RESEND_API_KEY: '',
  INVITE_EMAIL_FROM: ''
} as const;

function codes(problems: { code: BetaGuardCode }[]) {
  return problems.map(problem => problem.code);
}

describe('beta environment guard', () => {
  it('passes a valid beta profile', () => {
    expect(evaluateBetaEnvironment(VALID)).toEqual([]);
  });

  it('reports every problem in one pass rather than stopping at the first', () => {
    // A maintainer with three things wrong should fix them in one cycle.
    const problems = evaluateBetaEnvironment({
      ...VALID,
      VITE_SITE_URL: 'https://soty.pp.ua',
      VITE_LOCAL_DEV_AUTH: 'true',
      RESEND_API_KEY: 're_live_value'
    });
    expect(codes(problems)).toEqual(
      expect.arrayContaining([
        'BETA_PRODUCTION_ENDPOINT',
        'BETA_LOCAL_AUTH_FORBIDDEN',
        'BETA_DELIVERY_PROVIDER_FORBIDDEN'
      ])
    );
  });

  it.each(['VITE_SUPABASE_URL', 'VITE_SITE_URL', 'VITE_AGENT_URL', 'PUBLIC_SITE_ORIGIN'])(
    'rejects a production endpoint in %s',
    key => {
      const problems = evaluateBetaEnvironment({ ...VALID, [key]: 'https://soty.pp.ua' });
      const problem = problems.find(candidate => candidate.subject === key);
      expect(problem?.code).toBe('BETA_PRODUCTION_ENDPOINT');
      expect(problem?.message).toContain('soty.pp.ua');
      expect(problem?.remedy).toBeTruthy();
    }
  );

  it.each(['VITE_SUPABASE_URL', 'AGENT_ENTITLEMENT_PUBLIC_KEY', 'AGENT_PORT'])(
    'reports %s as missing when unset',
    key => {
      const problems = evaluateBetaEnvironment({ ...VALID, [key]: '' });
      const problem = problems.find(candidate => candidate.subject === key);
      expect(problem?.code).toBe('BETA_ENV_MISSING');
    }
  );

  it('rejects an environment value that is not beta', () => {
    const problems = evaluateBetaEnvironment({ ...VALID, SOTY_ENVIRONMENT: 'production' });
    const problem = problems.find(candidate => candidate.subject === 'SOTY_ENVIRONMENT');
    expect(problem?.code).toBe('BETA_ENV_MISSING');
  });

  it('refuses to reuse the production entitlement key', () => {
    const problems = evaluateBetaEnvironment(
      { ...VALID, AGENT_ENTITLEMENT_PUBLIC_KEY: 'production-public-key' },
      { productionEntitlementKey: 'production-public-key' }
    );
    const problem = problems.find(
      candidate => candidate.subject === 'AGENT_ENTITLEMENT_PUBLIC_KEY'
    );
    expect(problem?.code).toBe('BETA_PRODUCTION_ENDPOINT');
  });

  it('accepts a beta entitlement key that differs from production', () => {
    expect(
      evaluateBetaEnvironment(VALID, { productionEntitlementKey: 'production-public-key' })
    ).toEqual([]);
  });

  it('forbids faked local authentication', () => {
    // Soty Dev sets this to true. Copying that into beta would mean sign-in,
    // sessions, profiles, and account status are never exercised.
    const problems = evaluateBetaEnvironment({ ...VALID, VITE_LOCAL_DEV_AUTH: 'true' });
    expect(codes(problems)).toContain('BETA_LOCAL_AUTH_FORBIDDEN');
  });

  it.each(['RESEND_API_KEY', 'INVITE_EMAIL_FROM'])(
    'forbids the delivery-provider credential %s',
    key => {
      // Invitations bypass the local mail catcher entirely, so a credential
      // here would send real mail to real people from a test environment.
      const problems = evaluateBetaEnvironment({ ...VALID, [key]: 'configured-value' });
      const problem = problems.find(candidate => candidate.subject === key);
      expect(problem?.code).toBe('BETA_DELIVERY_PROVIDER_FORBIDDEN');
    }
  );

  it('reports occupied ports from an injected probe', () => {
    const problems = evaluateBetaEnvironment(VALID, { portsInUse: [BETA_PROFILE.agentPort] });
    const problem = problems.find(candidate => candidate.code === 'BETA_PORT_IN_USE');
    expect(problem?.subject).toBe(String(BETA_PROFILE.agentPort));
  });

  it('reports missing prerequisites from an injected probe', () => {
    const problems = evaluateBetaEnvironment(VALID, {
      missingPrerequisites: ['a container runtime']
    });
    const problem = problems.find(candidate => candidate.code === 'BETA_PREREQUISITE_MISSING');
    expect(problem?.subject).toBe('a container runtime');
    expect(problem?.remedy).toContain('container runtime');
  });

  it('names the offending subject on every problem', () => {
    const problems = evaluateBetaEnvironment(
      { ...VALID, VITE_SITE_URL: 'https://soty.pp.ua', RESEND_API_KEY: 'x' },
      { portsInUse: [5175], missingPrerequisites: ['Supabase CLI'] }
    );
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) {
      expect(problem.subject).toBeTruthy();
      expect(problem.remedy).toBeTruthy();
    }
  });
});

describe('reset target guard', () => {
  it('allows the local stack', () => {
    expect(evaluateResetTarget('postgresql://postgres@127.0.0.1:54322/postgres')).toBeNull();
    expect(evaluateResetTarget('postgresql://postgres@localhost:54322/postgres')).toBeNull();
  });

  it('allows an unset target so the reset uses the local default', () => {
    expect(evaluateResetTarget(undefined)).toBeNull();
    expect(evaluateResetTarget('')).toBeNull();
  });

  it('refuses a remote target', () => {
    const problem = evaluateResetTarget(
      'postgresql://postgres.abc:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres'
    );
    expect(problem?.code).toBe('BETA_RESET_TARGET_UNSAFE');
    expect(problem?.message).toContain('pooler.supabase.com');
  });

  it('refuses a target it cannot parse rather than assuming it is local', () => {
    expect(evaluateResetTarget('not a url')?.code).toBe('BETA_RESET_TARGET_UNSAFE');
  });
});

describe('invitation delivery containment in beta', () => {
  /**
   * Invitation mail is the one outbound path that does not pass through the
   * local mail catcher — the function posts straight to a delivery API. In beta
   * no delivery may be attempted at all, and the link must come back to the
   * caller so the flow stays exercisable without anything leaving the machine.
   */
  function dependencies(environment: 'production' | 'beta' | undefined, deliver: () => unknown) {
    return {
      createToken: () => 'opaque-invitation-token-00000001',
      rpc: async (name: string) =>
        name === 'create_invitation'
          ? {
              ok: true as const,
              value: {
                id: '30000000-0000-4000-8000-000000000001',
                teamName: 'Media buyers',
                inviterName: 'Owner',
                targetEmail: 'member@example.test'
              }
            }
          : { ok: true as const, value: true },
      deliver: deliver as never,
      siteUrl: BETA_SITE_ORIGIN,
      ...(environment ? { environment } : {})
    };
  }

  const command = {
    action: 'create' as const,
    teamId: '20000000-0000-4000-8000-000000000001',
    email: 'member@example.test',
    initialRole: 'viewer' as const,
    idempotencyKey: 'invite-attempt-01'
  };

  it('never attempts delivery in beta', async () => {
    const deliver = vi.fn();
    const result = await executeInvitationCommand(command, dependencies('beta', deliver) as never);
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toMatchObject({ deliveryState: 'failed' });
  });

  it('returns the invitation link in beta so the flow can still be completed', async () => {
    const result = (await executeInvitationCommand(
      command,
      dependencies('beta', vi.fn()) as never
    )) as { inviteUrl?: string };
    expect(result.inviteUrl).toContain(BETA_SITE_ORIGIN);
    expect(result.inviteUrl).toContain('opaque-invitation-token-00000001');
  });

  it('still delivers, and does not leak the link, outside beta', async () => {
    const deliver = vi.fn().mockResolvedValue({ state: 'sent', errorCode: null });
    const result = (await executeInvitationCommand(
      command,
      dependencies('production', deliver) as never
    )) as { inviteUrl?: string };
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(result.inviteUrl).toBeUndefined();
  });

  it('defaults to delivering when no environment is declared', async () => {
    // Absent means production everywhere else; delivery must not silently stop.
    const deliver = vi.fn().mockResolvedValue({ state: 'sent', errorCode: null });
    await executeInvitationCommand(command, dependencies(undefined, deliver) as never);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
