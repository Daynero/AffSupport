import { describe, expect, it } from 'vitest';
import {
  buildBridgeChunks,
  buildChunkWhisperArgs,
  buildSpeechChunks,
  buildVadDetectionArgs,
  buildWhisperArgs,
  collapseTranscriptArtifacts,
  mergeTranscriptChunks,
  parseVadSpeechRanges
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

  it('detects speech ranges before loading bounded no-timestamp chunks', () => {
    const detection = buildVadDetectionArgs(
      { wavPath: '/tmp/input.wav' },
      { threads: 4, vadModelPath: '/tmp/silero.bin' }
    );
    const chunks = buildChunkWhisperArgs(
      {
        wavPaths: ['/tmp/chunk-0.wav', '/tmp/chunk-1.wav'],
        language: 'hi'
      },
      { threads: 4 }
    );
    const recovery = buildChunkWhisperArgs(
      {
        wavPaths: ['/tmp/recovery.wav'],
        language: 'hi'
      },
      { threads: 4, preserveTimestamps: true }
    );

    expect(detection).toEqual(
      expect.arrayContaining(['-f', '/tmp/input.wav', '-dl', '--vad', '-vm', '/tmp/silero.bin'])
    );
    expect(chunks).toEqual(
      expect.arrayContaining(['-l', 'hi', '-nt', '-nf', '/tmp/chunk-0.wav', '/tmp/chunk-1.wav'])
    );
    expect(chunks).not.toContain('-of');
    expect(recovery).toContain('-otxt');
    expect(recovery).not.toContain('-nt');
    expect(recovery).not.toContain('--no-timestamps');
  });

  it('parses, joins, and bounds VAD speech ranges with overlap', () => {
    const ranges = parseVadSpeechRanges(`
      whisper_vad_segments_from_probs: VAD segment 0: start = 0.10, end = 43.25 (duration: 43.15)
      whisper_vad_segments_from_probs: VAD segment 1: start = 43.25, end = 47.00 (duration: 3.75)
      whisper_vad: vad_segment_info: orig_start: 0.10, orig_end: 43.25
    `);

    expect(ranges).toEqual([
      { startMs: 100, endMs: 43_250 },
      { startMs: 43_250, endMs: 47_000 }
    ]);
    const chunks = buildSpeechChunks(ranges, {
      chunkMs: 12_000,
      overlapMs: 3_000,
      mergeGapMs: 750,
      edgePaddingMs: 0
    });
    expect(chunks[0]).toEqual({ startMs: 100, endMs: 20_100 });
    expect(chunks.at(-1)).toEqual({ startMs: 35_000, endMs: 47_000 });
    expect(chunks.slice(1).every(chunk => chunk.endMs - chunk.startMs <= 12_000)).toBe(true);
  });

  it('adds a shifted bridge when adjacent audio windows share no text', () => {
    const bridges = buildBridgeChunks(
      [
        { startMs: 96_000, endMs: 108_000 },
        { startMs: 102_000, endMs: 114_000 }
      ],
      [
        'यह ओफर सीमित समय के लिए है और आपको बिना किसी जोखिम के इस समाधान को',
        'अगर उत्पाद आपके लिए काम नहीं करता तो मैं आपको पूरा पैसा वापस करने की गारंटी देता हूँ'
      ]
    );

    expect(bridges).toEqual([
      {
        beforeIndex: 1,
        range: { startMs: 96_000, endMs: 114_000 }
      }
    ]);
  });

  it('recovers a missing clause at any unstable boundary using both sides as context', () => {
    const left =
      'Şimdi erkek olarak haklarını talep etme zamanı. Aşağıdaki linke hemen tıkla. ' +
      'Bu stoğu daha cesur olanlar kapmadan şimdi al. Dünyaya kan';
    const recovery =
      'Şimdi erkek olarak haklarını talep etme zamanı. Aşağıdaki linke hemen tıkla. ' +
      'Bu stoğu daha cesur olanlar kapmadan şimdi al. Dünyaya kanıtla. ' +
      'Ve en önemlisi karına kanıtla. Yatakta gerçek kral kim?';
    const right = 'Yatakta gerçek kral kim?';

    const merged = mergeTranscriptChunks([left, recovery, right]);

    expect(merged).toContain('Dünyaya kanıtla.');
    expect(merged).toContain('Ve en önemlisi karına kanıtla.');
    expect(merged.match(/Yatakta gerçek kral kim\?/gu)).toHaveLength(1);
    expect(merged).not.toContain('Dünyaya kan\n');
  });

  it('merges overlapping short windows and replaces a hallucinated tail', () => {
    const merged = mergeTranscriptChunks([
      'अगर आप 80 वर्ष की उम्र में भी इस प्राकृतिक उपचार के केवल 3 ग्राम रोजाना लेते हैं यह उत्पाद अभी लागत',
      'तीन ग्राम रोजाना लेते हैं। यह उत्पाद अभी लागत मूल्य पर उपलब्ध है और ओर्डर करने पर आपको एक मुफ्त सैंपल उपहार में मिलेगा। ये ओफर सीमित समय के लिए है और आपको बिना किसी जोखिम के इस समाधान को',
      'और आपको बिना किसी जोखिम के इस समाधान को आजमाने का मौका देता है अगर उत्पाद आपके लिए काम नहीं करता तो मैं आपको पूरा पैसा वापस करने की गारंटी देता हूँ अभी ओर्डर कीजिए और आप कल',
      'आपके लिए काम नहीं करता तो मैं आपको पूरा पैसा वापस करने की गारंटी देता हूँ अभी ओर्डर कीजिए और आप कल ही परिणाम महसूस करेंगे अभी कदम उठाईए और अपने निजी स्वास्थे पर फिर से नियंत्रन पाईए'
    ]);

    expect(merged).toContain('यह उत्पाद अभी लागत मूल्य पर उपलब्ध है');
    expect(merged).toContain('एक मुफ्त सैंपल उपहार में मिलेगा');
    expect(merged).toContain('बिना किसी जोखिम के इस समाधान को आजमाने का मौका देता है');
    expect(merged).toContain('अपने निजी स्वास्थे पर फिर से नियंत्रन पाईए');
    expect(merged.match(/पूरा पैसा वापस करने की गारंटी देता हूँ/gu)).toHaveLength(1);
  });

  it('merges scripts that do not put spaces between words', () => {
    expect(
      mergeTranscriptChunks([
        '这是一个完整的测试句子用于检查转录',
        '测试句子用于检查转录不会遗漏任何内容。'
      ])
    ).toBe('这是一个完整的测试句子用于检查转录不会遗漏任何内容。');
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
