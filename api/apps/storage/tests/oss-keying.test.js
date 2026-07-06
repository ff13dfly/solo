/**
 * Hermetic unit test for apps/storage/oss/keying.js.
 *
 * The load-bearing guarantee: keyFor(sha, ext) is BYTE-IDENTICAL to the 2/2/2
 * object path filestore.save() writes today, so existing on-disk assets map 1:1
 * onto object keys (zero-copy cutover). We prove it by saving via the real
 * filestore and asserting keyFor reproduces the same relative path.
 *
 * No redis, no network — pure compute + an OS temp dir for the filestore writes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const filestore = require('../../../library/filestore');
const { keyFor, thumbKeyFor, processSpecFor } = require('../oss/keying');

const sha = (d) => crypto.createHash('sha256').update(d).digest('hex');

let ROOT;
beforeAll(() => { ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-keying-')); });
afterAll(() => { if (ROOT) fs.rmSync(ROOT, { recursive: true, force: true }); });

describe('keyFor — matches filestore 2/2/2 layout', () => {
    test('reproduces the exact relative path filestore.save writes (with extension)', () => {
        for (const content of ['hello world', 'abc', 'another-asset', Buffer.from([0, 1, 2, 3, 4])]) {
            const ext = '.png';
            const saved = filestore.save(content, ROOT, { extension: ext });
            const expectedKey = saved.path.split(path.sep).join('/'); // posix object key
            expect(keyFor(saved.sha256, ext)).toBe(expectedKey);
        }
    });

    test('no-extension key is the bare 2/2/2 partition + remainder', () => {
        const h = sha('x');
        expect(keyFor(h)).toBe(`${h.slice(0, 2)}/${h.slice(2, 4)}/${h.slice(4, 6)}/${h.slice(6)}`);
    });

    test('rejects a hash shorter than 6 chars', () => {
        expect(() => keyFor('abc')).toThrow(/at least 6/);
        expect(() => keyFor('')).toThrow();
    });
});

describe('thumbKeyFor', () => {
    test('appends _<label>.jpg to the no-extension key (matches legacy thumb path)', () => {
        const h = sha('y');
        expect(thumbKeyFor(h, 'md')).toBe(`${keyFor(h)}_md.jpg`);
    });
    test('requires a label', () => {
        expect(() => thumbKeyFor(sha('z'))).toThrow(/label/);
    });
});

describe('processSpecFor', () => {
    test('maps a known preset to a resize spec', () => {
        expect(processSpecFor('md', { sm: 90, md: 320, lg: 800 })).toBe('resize,w_320');
        expect(processSpecFor('sm', { sm: 90 })).toBe('resize,w_90');
    });
    test('returns null for an unknown preset', () => {
        expect(processSpecFor('xl', { sm: 90 })).toBeNull();
        expect(processSpecFor('md', {})).toBeNull();
    });
});
