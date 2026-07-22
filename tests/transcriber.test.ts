import { describe, expect, it } from 'vitest';
import {
  buildWhisperArgs,
  collapseTranscriptArtifacts
} from '../apps/agent/src/whisper/transcriber.js';

describe('Whisper transcription safeguards', () => {
  it('keeps timestamp tokens enabled while writing a plain-text transcript', () => {
    const args = buildWhisperArgs(
      {
        wavPath: '/tmp/input.wav',
        outputBase: '/tmp/transcript',
        language: 'hi'
      },
      { threads: 4, vadModelPath: '/tmp/silero.bin' }
    );

    expect(args).toContain('-otxt');
    expect(args).not.toContain('-nt');
    expect(args).not.toContain('--no-timestamps');
    expect(args).toEqual(expect.arrayContaining(['--vad', '-vm', '/tmp/silero.bin', '-l', 'hi']));
  });

  it('replaces mid-word decoder fragments with their corrected segments', () => {
    const fragments = [
      'यह नसल, लंबाई, जूते के आकार या किसी अन्य बे',
      'यह नसल, लंबाई, जूते के आकार या किसी अन्य बेकार चीज़ पर निर्भर नहीं करता',
      'मुझे आपको बताने दी',
      'मुझे आपको बताने दीजिये कि आप 70 या 80 वर्ष की उम्र में भी अपना इरेक्शन कैसे बनाए रख सकते हैं',
      'अगर आपको बिस्तर में समस्याएं हैं अगर सुबह इरेक्शन नहीं होता या जरूरत पढ़ने पर नहीं होता तो म',
      'अगर आपको बिस्तर में समस्याएं हैं, अगर सुबह इरेक्शन नहीं होता या जरूरत पढ़ने पर नहीं होता, तो मुझे सिर्फ 30 सेकंड दीजिए, व्यागरा का सहारा मत लीजिए.',
      'हाँ, ये थोड़े समय के लिए असर दे सकती है, लेकिन वास्तव में स्थिती क',
      'हाँ, ये थोड़े समय के लिए असर दे सकती है, लेकिन वास्तव में स्थिती को और खराब कर देती है।',
      'अभी ओडर कीजिए और आप कल ही परिणाम महस',
      'अभी ओडर कीजिए और आप कल ही परिणाम महसूस करेंगे'
    ];

    expect(collapseTranscriptArtifacts(fragments)).toEqual([
      fragments[1],
      fragments[3],
      fragments[5],
      fragments[7],
      fragments[9]
    ]);
  });

  it('keeps real sentences that share a complete opening phrase', () => {
    const lines = ['We should leave now', 'We should leave now before dark'];
    expect(collapseTranscriptArtifacts(lines)).toEqual(lines);
  });
});
