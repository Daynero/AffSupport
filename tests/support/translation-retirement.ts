/** Synthetic pre-retirement data. No user content, paths or credentials. */
export const originalDocumentFixture = () => ({
  jobId: '81000000-0000-4000-8000-000000000001',
  sourceLanguage: 'uk',
  modelVersion: 'speech-fixture',
  segments: [{ id: 's1', sourceText: 'Оригінал.', startMs: 0, endMs: 1000, words: [] }]
});

export const retiredPayloads = [null, [], 'damaged', { uk: { status: 'processing' } }];
