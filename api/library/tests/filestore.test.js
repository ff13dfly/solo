/**
 * Hermetic unit test for library/filestore.js — the CAS (content-addressable
 * storage) helper. Pure compute (SHA-256 path/hash derivation) plus disk writes.
 *
 * All disk I/O is confined to an OS temp dir created in beforeAll and torn down
 * in afterAll. No redis, no network, no clock/randomness dependence — the same
 * content always maps to the same path, which is exactly what we assert.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('../filestore');

// Reference hashes computed independently from the module under test.
const sha = (data) =>
    crypto.createHash('sha256').update(data).digest('hex');

let ROOT;

beforeAll(() => {
    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-filestore-'));
});

afterAll(() => {
    if (ROOT) fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('filestore.save — content-addressed write', () => {
    test('derives id/sha256/path/size from content hash and writes the bytes', () => {
        const content = 'hello world';
        const fullHash = sha(Buffer.from(content)); // b94d27b9...

        const res = store.save(content, ROOT);

        // id == sha256 of content when no key override
        expect(res.id).toBe(fullHash);
        expect(res.sha256).toBe(fullHash);
        expect(res.size).toBe(Buffer.byteLength(content));

        // 2/2/2 directory partitioning, remainder is filename
        const expectedRel = path.join(
            fullHash.substring(0, 2),
            fullHash.substring(2, 4),
            fullHash.substring(4, 6),
            fullHash.substring(6)
        );
        expect(res.path).toBe(expectedRel);
        expect(res.absolutePath).toBe(path.join(ROOT, expectedRel));

        // bytes actually landed on disk and round-trip equal
        expect(fs.existsSync(res.absolutePath)).toBe(true);
        expect(fs.readFileSync(res.absolutePath, 'utf8')).toBe(content);
    });

    test('Buffer content hashes identically to its string form', () => {
        const buf = Buffer.from('hello world');
        const res = store.save(buf, ROOT);
        expect(res.sha256).toBe(sha(buf));
        expect(res.id).toBe(res.sha256);
    });

    test('appends extension to the filename only (not the directory levels)', () => {
        const content = 'image-bytes';
        const fullHash = sha(Buffer.from(content));
        const res = store.save(content, ROOT, { extension: '.png' });

        expect(res.path.endsWith(`${fullHash.substring(6)}.png`)).toBe(true);
        expect(res.absolutePath.endsWith('.png')).toBe(true);
        // size is the raw content length, unaffected by the extension
        expect(res.size).toBe(Buffer.byteLength(content));
        expect(fs.existsSync(res.absolutePath)).toBe(true);
    });

    test('is deterministic / idempotent — same content overwrites same path', () => {
        const a = store.save('repeat-me', ROOT);
        const b = store.save('repeat-me', ROOT);
        expect(b.absolutePath).toBe(a.absolutePath);
        expect(b.id).toBe(a.id);
        // overwrite, not append: content remains intact
        expect(fs.readFileSync(b.absolutePath, 'utf8')).toBe('repeat-me');
    });

    test('key override: partition path uses sha256(key), sha256 field stays content hash', () => {
        const content = 'payload-bytes';
        const key = 'my-custom-key';
        const keyHash = sha(key);
        const contentHash = sha(Buffer.from(content));

        const res = store.save(content, ROOT, { key });

        // id (and therefore the path) is driven by the key hash...
        expect(res.id).toBe(keyHash);
        expect(res.path.startsWith(
            path.join(keyHash.substring(0, 2), keyHash.substring(2, 4))
        )).toBe(true);
        // ...but sha256 still reflects the actual content for integrity
        expect(res.sha256).toBe(contentHash);
        expect(res.sha256).not.toBe(res.id);
    });

    test('different content yields a different path', () => {
        const r1 = store.save('content-one', ROOT);
        const r2 = store.save('content-two', ROOT);
        expect(r2.absolutePath).not.toBe(r1.absolutePath);
    });
});

describe('filestore.save — input validation', () => {
    test('missing content throws', () => {
        expect(() => store.save(undefined, ROOT)).toThrow(/Missing content/);
        expect(() => store.save(null, ROOT)).toThrow(/Missing content/);
    });

    test('empty string is treated as missing content (falsy guard)', () => {
        expect(() => store.save('', ROOT)).toThrow(/Missing content/);
    });

    test('missing root folder throws', () => {
        expect(() => store.save('data', undefined)).toThrow(/Missing root folder/);
        expect(() => store.save('data', '')).toThrow(/Missing root folder/);
    });
});

describe('filestore.resolve — pure path derivation', () => {
    test('rebuilds the same absolute path save() produced', () => {
        const content = 'resolve-me';
        const saved = store.save(content, ROOT);
        expect(store.resolve(saved.id, ROOT)).toBe(saved.absolutePath);
    });

    test('honors the extension argument', () => {
        const id = sha('anything'); // a valid 64-char hex id
        const expected = path.join(
            ROOT,
            id.substring(0, 2),
            id.substring(2, 4),
            id.substring(4, 6),
            `${id.substring(6)}.json`
        );
        expect(store.resolve(id, ROOT, '.json')).toBe(expected);
    });

    test('returns null for ids shorter than 6 chars', () => {
        expect(store.resolve('abcde', ROOT)).toBeNull();
        expect(store.resolve('', ROOT)).toBeNull();
        expect(store.resolve(undefined, ROOT)).toBeNull();
    });

    test('exactly 6 chars resolves (empty remainder filename)', () => {
        const res = store.resolve('abcdef', ROOT);
        expect(res).toBe(path.join(ROOT, 'ab', 'cd', 'ef', ''));
    });
});

describe('filestore.exists — disk existence check', () => {
    test('true after a save, via the returned id', () => {
        const saved = store.save('exists-me', ROOT, { extension: '.bin' });
        expect(store.exists(saved.id, ROOT, '.bin')).toBe(true);
    });

    test('false when the extension does not match the stored file', () => {
        const saved = store.save('ext-mismatch', ROOT, { extension: '.bin' });
        expect(store.exists(saved.id, ROOT, '.txt')).toBe(false);
    });

    test('false for an id that was never written', () => {
        const ghost = sha('never-written-content');
        expect(store.exists(ghost, ROOT)).toBe(false);
    });

    test('false for an invalid (too-short) id without throwing', () => {
        expect(store.exists('abc', ROOT)).toBe(false);
        expect(store.exists('', ROOT)).toBe(false);
    });
});
