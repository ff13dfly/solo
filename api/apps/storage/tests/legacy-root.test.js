/**
 * legacy-root.test.js — 默认落盘目录移进项目后，旧位置遗留资产的启动守卫。
 * hermetic：临时目录 + Map 假 Redis，直接驱动 oss/legacy-root.js。
 *
 * 🔴 默认 root 曾按源码深度写成 __dirname/../../../uploads/assets，从 bundle 跑（api/publish/）
 * 就落到项目的父目录——同机所有项目共用、项目备份不含它。现在默认在项目内；已经把字节写在
 * 上面的栈若不迁就升级，会起在一个空 root 上：resolve 照样返回 URL，字节全没，不报错。
 * 守卫按「本项目自己的资产记录」判定，**绝不**按「旧目录非空」判定——那个目录是共享的。
 * 见 docs/feedback/done/bundle-upload-dir-escapes-project-root.md
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { legacyRootOf, findStrandedAssets } = require('../oss/legacy-root');

const redisKeys = { assetIdSortedSet: 'STORAGE:ASSETS:SORTED', assetPrefix: 'STORAGE:ASSET:' };

function makeRedis(records) {   // records: [{ id, key }] newest first
    const kv = new Map(records.map((r) => [`${redisKeys.assetPrefix}${r.id}`, JSON.stringify({ id: r.id, key: r.key, path: r.key })]));
    const ids = records.map((r) => r.id);
    return {
        async zRange(_k, start, stop) { return ids.slice(start, stop + 1); },
        async mGet(keys) { return keys.map((k) => (kv.has(k) ? kv.get(k) : null)); },
    };
}

function touch(root, key) {
    const f = path.join(root, key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x');
}

describe('legacy root guard', () => {
    let base, project, root, legacyRoot;
    beforeEach(() => {
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'solo-legacy-root-'));
        project = path.join(base, 'proj');
        root = path.join(project, 'uploads', 'assets');
        legacyRoot = legacyRootOf(project);
        fs.mkdirSync(project, { recursive: true });
    });
    afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

    test('旧默认 = 项目父目录下的 uploads/assets（bundle 当年实际算出的位置）', () => {
        expect(legacyRootOf('/home/web/AI/steward')).toBe('/home/web/AI/uploads/assets');
    });

    test('🔴 本项目的字节还在旧位置、新位置没有 ⇒ 报出来（steward 不迁就升级的情形）', async () => {
        touch(legacyRoot, 'aa/bb/cc/1.png');
        touch(legacyRoot, 'dd/ee/ff/2.png');
        const redisClient = makeRedis([{ id: 'a1', key: 'aa/bb/cc/1.png' }, { id: 'a2', key: 'dd/ee/ff/2.png' }]);
        const stranded = await findStrandedAssets({ redisClient, redisKeys, root, legacyRoot });
        expect(stranded).toEqual(['aa/bb/cc/1.png', 'dd/ee/ff/2.png']);
    });

    test('🔴 旧目录里是**别的项目**的文件 ⇒ 不拦（共享目录非空不代表与我有关）', async () => {
        touch(legacyRoot, '11/22/33/other.png');
        const redisClient = makeRedis([{ id: 'm1', key: 'aa/bb/cc/mine.png' }]);
        touch(root, 'aa/bb/cc/mine.png');
        expect(await findStrandedAssets({ redisClient, redisKeys, root, legacyRoot })).toEqual([]);
    });

    test('没有任何资产记录的项目（新项目、从没用过 storage）⇒ 不拦', async () => {
        touch(legacyRoot, '11/22/33/other.png');
        expect(await findStrandedAssets({ redisClient: makeRedis([]), redisKeys, root, legacyRoot })).toEqual([]);
    });

    test('已经迁完（字节在新位置）⇒ 不拦，哪怕旧位置还留着一份', async () => {
        touch(legacyRoot, 'aa/bb/cc/1.png');
        touch(root, 'aa/bb/cc/1.png');
        const redisClient = makeRedis([{ id: 'a1', key: 'aa/bb/cc/1.png' }]);
        expect(await findStrandedAssets({ redisClient, redisKeys, root, legacyRoot })).toEqual([]);
    });

    test('两边都没有字节（早已丢失的记录）⇒ 不拦：守卫只管「迁移漏了」，不替丢失背锅', async () => {
        fs.mkdirSync(legacyRoot, { recursive: true });
        const redisClient = makeRedis([{ id: 'lost', key: 'aa/bb/cc/lost.png' }]);
        expect(await findStrandedAssets({ redisClient, redisKeys, root, legacyRoot })).toEqual([]);
    });

    test('旧目录根本不存在 ⇒ 不查 Redis 直接放行', async () => {
        const redisClient = { zRange: jest.fn(), mGet: jest.fn() };
        expect(await findStrandedAssets({ redisClient, redisKeys, root, legacyRoot })).toEqual([]);
        expect(redisClient.zRange).not.toHaveBeenCalled();
    });

    test('root 就是旧位置（显式钉在那儿）⇒ 不拦', async () => {
        touch(legacyRoot, 'aa/bb/cc/1.png');
        const redisClient = makeRedis([{ id: 'a1', key: 'aa/bb/cc/1.png' }]);
        expect(await findStrandedAssets({ redisClient, redisKeys, root: legacyRoot, legacyRoot })).toEqual([]);
    });

    test('只抽样最新 N 条；坏 JSON / 缺 key 的记录跳过不炸', async () => {
        touch(legacyRoot, 'aa/bb/cc/1.png');
        const redisClient = makeRedis([{ id: 'a1', key: 'aa/bb/cc/1.png' }, { id: 'a2', key: 'zz/zz/zz/old.png' }]);
        redisClient.mGet = async (keys) => ['{broken', JSON.stringify({ id: 'x' }), ...keys.slice(2).map(() => null)];
        expect(await findStrandedAssets({ redisClient, redisKeys, root, legacyRoot, sample: 2 })).toEqual([]);
    });
});
