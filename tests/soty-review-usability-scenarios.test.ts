import { describe, expect, it } from 'vitest';

export const primaryActionStudy = {
  participants: 20,
  screens: ['home-tools', 'compressor', 'landing-optimizer', 'transcription', 'team-workspace'],
  identifyWithinSeconds: 5,
  openToolWithinSeconds: 20,
  requiredSuccesses: 18,
  allowedWrongTurns: 1
} as const;

describe('Soty usability scenario contract', () => {
  it('encodes SC-004 and SC-005 thresholds', () => {
    expect(primaryActionStudy.screens).toHaveLength(5);
    expect(primaryActionStudy.requiredSuccesses / primaryActionStudy.participants).toBe(0.9);
  });
});
