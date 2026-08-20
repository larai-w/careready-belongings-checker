import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutingMemoCandidate } from '../lib/care-event.js';

test('buildOutingMemoCandidate normalizes a non-empty memo without sending it', () => {
  const candidate = buildOutingMemoCandidate({
    eventId: 'synthetic-careready-memo-001',
    outingId: 'so_synthetic-001',
    memo: '  玄関で確認する  ',
    recordedAt: '2035-01-02T10:00:00+09:00',
  });
  assert.deepEqual(candidate, {
    status: 'contract-review-required',
    source: 'careready',
    eventId: 'synthetic-careready-memo-001',
    eventType: 'outing_memo_recorded',
    outingId: 'so_synthetic-001',
    memo: '玄関で確認する',
    recordedAt: '2035-01-02T10:00:00+09:00',
  });
});

test('empty memo is not exported as an event candidate', () => {
  assert.equal(
    buildOutingMemoCandidate({
      eventId: 'synthetic-careready-memo-002',
      outingId: 'so_synthetic-001',
      memo: '   ',
      recordedAt: '2035-01-02T10:00:00+09:00',
    }),
    null,
  );
});
