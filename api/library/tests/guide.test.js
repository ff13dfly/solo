/**
 * library/guide.js — fleet-standard `guide` 读取的三条路径:
 *   1. from-source:读 serviceDir/GUIDE.md
 *   2. bundle:global.__SOLO_GUIDES__ 构建时嵌入优先(镜像 __SOLO_PORTS__ 模式)
 *   3. 都没有:明确 available:false,不抛错
 * Hermetic:仅 fs + os.tmpdir,无 Redis/网络。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readGuide } = require('../guide');

describe('library/guide readGuide', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-test-'));
        delete global.__SOLO_GUIDES__;
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        delete global.__SOLO_GUIDES__;
    });

    test('from-source: reads GUIDE.md from the service directory', () => {
        fs.writeFileSync(path.join(tmpDir, 'GUIDE.md'), '# hello recipe');
        const out = readGuide('svc', tmpDir);
        expect(out).toEqual({ available: true, format: 'markdown', content: '# hello recipe' });
    });

    test('missing GUIDE.md: explicit available:false, no throw', () => {
        const out = readGuide('svc', tmpDir);
        expect(out.available).toBe(false);
        expect(out.message).toContain('svc');
    });

    test('bundle: __SOLO_GUIDES__ embedded content wins over fs', () => {
        fs.writeFileSync(path.join(tmpDir, 'GUIDE.md'), 'from fs');
        global.__SOLO_GUIDES__ = { svc: 'from bundle' };
        const out = readGuide('svc', tmpDir);
        expect(out).toEqual({ available: true, format: 'markdown', content: 'from bundle' });
    });

    test('bundle map present but service not embedded: falls back to fs', () => {
        fs.writeFileSync(path.join(tmpDir, 'GUIDE.md'), 'from fs');
        global.__SOLO_GUIDES__ = { other: 'x' };
        const out = readGuide('svc', tmpDir);
        expect(out.content).toBe('from fs');
    });

    test('non-string embedded value is ignored (defensive)', () => {
        global.__SOLO_GUIDES__ = { svc: 42 };
        const out = readGuide('svc', tmpDir);
        expect(out.available).toBe(false);
    });
});
