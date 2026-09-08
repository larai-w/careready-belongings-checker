import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBackup, parseBackup, BACKUP_KEYS, MAX_BACKUP_BYTES } from '../lib/backup.js';
const encode = b => JSON.stringify(b);
test('preparation backup preserves checks and boxes but excludes private diary and preferences', () => {
 const state = { checked: { towel: true }, containers: { towel: 'box1' }, diary: [{ photo: 'private' }], personName: 'private', memos: { x: 'private' }, pushEnabled: true };
 const backup = makeBackup(state);
 assert.deepEqual(Object.keys(backup.data), BACKUP_KEYS);
 assert.deepEqual(parseBackup(encode(backup)).data.checked, state.checked);
 assert.equal(encode(backup).includes('private'), false);
 state.checked.towel = false;
 assert.equal(backup.data.checked.towel, true);
});
test('repeated parsing produces equivalent independent data', () => {
 const raw = encode(makeBackup({ customItems: [{ id: 'custom-test', name: '合成タオル', applicable_locations: ['shortstay'], quantity: 1 }] }));
 assert.deepEqual(parseBackup(raw), parseBackup(raw));
});
test('invalid JSON, oversized files, other apps, unsupported versions and dates are rejected', () => {
 for (const raw of ['{', ' '.repeat(MAX_BACKUP_BYTES + 1), ...[{ app: 'other' }, { version: 2 }, { createdAt: 'invalid' }].map(change => encode({ ...makeBackup({}), ...change }))]) assert.throws(() => parseBackup(raw));
});
test('malformed state, duplicate IDs and dangerous keys are rejected', () => {
 for (const edit of [b => delete b.data.checked, b => b.data.checked.x = 'true', b => b.data.viewMode = 'other', b => b.data.customItems = [{id:'x', name:'a'}, {id:'x', name:'b'}], b => b.data.customItems = [{id:'x', name:'a', applicable_locations:'shortstay'}], b => b.data.checked = JSON.parse('{"__proto__":true}')]) {
  const b = makeBackup({}); edit(b); assert.throws(() => parseBackup(encode(b)));
 }
});
test('facility items and default missing state round trip', () => {
 const b = makeBackup({ facilityTemplate: { name: '合成施設', items: [{ id: 'facility-x', name: '合成品' }], overrides: { hide: ['towel'] } } });
 assert.deepEqual(parseBackup(encode(b)), b);
 assert.equal(b.data.activeBox, null);
});
