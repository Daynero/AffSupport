import { describe, expect, it } from 'vitest';
import {
  buildWhisperArgs,
  collapseTranscriptArtifacts,
  dropTrailingCredits,
  isCreditHallucination,
  shouldCreateEnglishPivot,
  stripCreditSuffix,
  stripNonSpeechArtifacts
} from '../apps/agent/src/whisper/transcriber.js';

describe('Whisper long-form transcription', () => {
  it('builds a single long-form pass with word timestamps and VAD', () => {
    const args = buildWhisperArgs(
      { wavPath: '/tmp/input.wav', outputBase: '/tmp/transcript', language: 'ar' },
      { threads: 4, vadModelPath: '/tmp/silero.bin' }
    );

    expect(args).toEqual(
      expect.arrayContaining([
        '-f',
        '/tmp/input.wav',
        '-l',
        'ar',
        '-otxt',
        '-oj',
        '-ojf',
        '-sow',
        '-of',
        '/tmp/transcript',
        '-pp',
        '-bs',
        '5',
        '-bo',
        '5',
        '-sns',
        '--vad',
        '-vm',
        '/tmp/silero.bin'
      ])
    );
    expect(args).not.toContain('-nt');
    expect(args).not.toContain('--no-timestamps');
    // The source pass never translates.
    expect(args).not.toContain('-tr');
  });

  it('omits VAD flags on runtimes without the Silero model', () => {
    const args = buildWhisperArgs(
      { wavPath: '/tmp/input.wav', outputBase: '/tmp/out', language: 'auto' },
      { threads: 4, vadModelPath: null }
    );

    expect(args).not.toContain('--vad');
    expect(args).not.toContain('-vm');
    expect(args).toContain('-otxt');
    expect(args).toEqual(expect.arrayContaining(['-l', 'auto']));
  });

  it('adds the speech→English task only for the pivot pass', () => {
    const source = buildWhisperArgs(
      { wavPath: '/tmp/a.wav', outputBase: '/tmp/a', language: 'hi' },
      { threads: 4, vadModelPath: '/tmp/silero.bin' }
    );
    const pivot = buildWhisperArgs(
      { wavPath: '/tmp/a.wav', outputBase: '/tmp/a-en', language: 'hi', translateToEnglish: true },
      { threads: 4, vadModelPath: '/tmp/silero.bin' }
    );

    expect(source).not.toContain('-tr');
    expect(pivot).toEqual(expect.arrayContaining(['-l', 'hi', '-tr']));
  });

  it('limits the extra speech-to-English pass to measured weak source languages', () => {
    expect(shouldCreateEnglishPivot('hi', true)).toBe(true);
    expect(shouldCreateEnglishPivot('ur-PK', true)).toBe(true);
    expect(shouldCreateEnglishPivot('tr', true)).toBe(false);
    expect(shouldCreateEnglishPivot('hi', false)).toBe(false);
    expect(shouldCreateEnglishPivot(null, true)).toBe(false);
  });

  it('drops the trailing Arabic translator-credit hallucination', () => {
    const lines = [
      'الحجم الصغير وعدم استقرار الانتصاب ليس حكما نهائيا',
      'لا تفوتوا فرصتكم',
      'ترجمة نانسي قنقر'
    ];

    expect(dropTrailingCredits(lines)).toEqual([
      'الحجم الصغير وعدم استقرار الانتصاب ليس حكما نهائيا',
      'لا تفوتوا فرصتكم'
    ]);
  });

  it('recognizes common subtitle-credit hallucinations but keeps real speech', () => {
    expect(isCreditHallucination('ترجمة نانسي قنقر')).toBe(true);
    expect(isCreditHallucination('اشتركوا في القناة')).toBe(true);
    expect(isCreditHallucination('Thanks for watching!')).toBe(true);
    expect(isCreditHallucination('Subtitles by the Amara.org community')).toBe(true);
    expect(isCreditHallucination('Please subscribe')).toBe(true);

    // Real spoken lines must never be treated as credits.
    expect(isCreditHallucination('لا تفوتوا فرصتكم')).toBe(false);
    expect(isCreditHallucination('شكرا لكم وسنبدأ الآن بشرح المنتج بالتفصيل')).toBe(false);
    expect(isCreditHallucination('This product improves your health today')).toBe(false);
  });

  it('strips a credit clause appended after the final sentence', () => {
    expect(stripCreditSuffix('لا تفوتوا فرصتكم. ترجمة نانسي قنقر')).toBe('لا تفوتوا فرصتكم.');
    expect(stripCreditSuffix('Order now. Thanks for watching')).toBe('Order now.');
    // A normal trailing clause is left untouched.
    expect(stripCreditSuffix('Order now. Do not miss your chance')).toBe(
      'Order now. Do not miss your chance'
    );
  });

  it('only removes credits at the tail, never a credit-like line mid-transcript', () => {
    const lines = ['ترجمة هذا الكلام مهمة جدا للفهم', 'ثم ننتقل إلى المنتج', 'لا تفوتوا فرصتكم'];
    // The final line is real, so nothing is dropped even though line 0 looks
    // credit-shaped — trailing-only removal keeps mid-transcript speech safe.
    expect(dropTrailingCredits(lines)).toEqual(lines);
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

  it('strips hallucination markers and bare ellipses from a line', () => {
    // The sanitizer blanks markers to whitespace; the caller trims per line.
    expect(stripNonSpeechArtifacts('[BLANK_AUDIO]').trim()).toBe('');
    expect(stripNonSpeechArtifacts('(music)').trim()).toBe('');
    expect(stripNonSpeechArtifacts('♪ ♪').trim()).toBe('');
    expect(stripNonSpeechArtifacts('Це перевірений засіб ... який працює швидко...')).toBe(
      'Це перевірений засіб який працює швидко'
    );
  });

  it('keeps sentence-final ellipsis attached to a word mid-line', () => {
    expect(stripNonSpeechArtifacts('Ну я не знаю... може бути.')).toBe(
      'Ну я не знаю... може бути.'
    );
    expect(stripNonSpeechArtifacts('обірвана думка на межі вікна...')).toBe(
      'обірвана думка на межі вікна'
    );
  });

  it('drops artifact-only lines during artifact collapse', () => {
    expect(collapseTranscriptArtifacts(['...', 'Справжній текст.', '—', '…'])).toEqual([
      'Справжній текст.'
    ]);
  });
});
