// Pure, offline-safe candidate builder for a future CareReady memo contract.
// This deliberately does not send data or claim compatibility with care-event/v1.

const MAX_MEMO_LENGTH = 500;

export function buildOutingMemoCandidate({
  eventId,
  outingId,
  memo,
  recordedAt,
}) {
  if (typeof eventId !== 'string' || !eventId.trim()) {
    throw new TypeError('eventId is required');
  }
  if (typeof outingId !== 'string' || !outingId.trim()) {
    throw new TypeError('outingId is required');
  }
  if (typeof memo !== 'string') {
    throw new TypeError('memo must be a string');
  }
  const normalizedMemo = memo.trim().slice(0, MAX_MEMO_LENGTH);
  if (!normalizedMemo) return null;
  if (typeof recordedAt !== 'string' || !recordedAt.trim()) {
    throw new TypeError('recordedAt is required');
  }

  return {
    status: 'contract-review-required',
    source: 'careready',
    eventId: eventId.trim(),
    eventType: 'outing_memo_recorded',
    outingId: outingId.trim(),
    memo: normalizedMemo,
    recordedAt: recordedAt.trim(),
  };
}
