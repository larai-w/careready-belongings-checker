import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the opening public claim keeps facility publishing in its current validation scope', () => {
    const manifest = JSON.parse(read('product.json'));
    const intro = read('README.md').split('**Status:**')[0].replace(/\s+/g, ' ');
    const status = read('README.md').split('## Status & Limitations')[1]?.split('\n---\n')[0];

    assert.equal(manifest.availability.stage, 'public-mvp');
    assert.match(manifest.availability.summary.en, /family checklist.*public/i);
    assert.match(manifest.availability.summary.en, /facility administration.*validat/i);
    assert.match(intro, /family caregivers/i);
    assert.match(intro, /staff-side template publishing.*validat/i);
    assert.match(status, /facility admin portal.*in progress|In progress.*facility admin portal/i);
});
