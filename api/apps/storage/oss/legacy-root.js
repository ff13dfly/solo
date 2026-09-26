/**
 * apps/storage/oss/legacy-root.js — detect assets stranded under the OLD built-in default root.
 *
 * @why  The local-OSS root used to default to `path.join(__dirname, '../../../uploads/assets')`.
 *       That is the project root from source (api/apps/storage/), but the bundle runs from
 *       <project>/api/publish/, so every bundled stack wrote its bytes one level too high:
 *       `<project>/../uploads/assets`, shared by every Solo project on the machine and outside
 *       every project backup. The default now lives inside the project. A stack that already
 *       has assets up there and upgrades without moving them would come up with an empty root
 *       — `resolve` keeps handing out URLs, the bytes are simply gone, nothing errors.
 *       (docs/feedback/done/bundle-upload-dir-escapes-project-root.md)
 * @attention Attribution is by THIS project's own asset records, never by "the old directory
 *       is non-empty": that directory is shared, so another project's files in it say nothing
 *       about this one. A project with no records, or whose bytes are already in the new root,
 *       is never blocked.
 */
const fs = require('fs');
const path = require('path');

/** The old default exactly as the bundle resolved it: <project>/../uploads/assets. */
function legacyRootOf(projectRoot) {
    return path.resolve(projectRoot, '..', 'uploads', 'assets');
}

/**
 * Sample this project's newest assets; return the object keys whose bytes are missing from
 * `root` but present under `legacyRoot`. Empty array = nothing stranded.
 * @param {object} o
 * @param {object} o.redisClient  node-redis client (zRange + mGet)
 * @param {object} o.redisKeys    storage config.redis (assetIdSortedSet, assetPrefix)
 * @param {string} o.root         the root this process is about to serve
 * @param {string} o.legacyRoot   legacyRootOf(projectRoot)
 * @param {number} [o.sample=20]  newest N records checked — enough to tell "moved" from "not moved"
 */
async function findStrandedAssets({ redisClient, redisKeys, root, legacyRoot, sample = 20, fsImpl = fs }) {
    if (path.resolve(root) === path.resolve(legacyRoot)) return [];
    if (!fsImpl.existsSync(legacyRoot)) return [];

    const ids = await redisClient.zRange(redisKeys.assetIdSortedSet, 0, sample - 1, { REV: true });
    if (!ids.length) return [];
    const raws = await redisClient.mGet(ids.map((id) => `${redisKeys.assetPrefix}${id}`));

    const stranded = [];
    for (const raw of raws) {
        if (!raw) continue;
        let meta;
        try { meta = JSON.parse(raw); } catch { continue; }
        const key = meta.key || meta.path;   // same precedence as logic/asset.js objectKeyOf
        if (!key) continue;
        if (!fsImpl.existsSync(path.join(root, key)) && fsImpl.existsSync(path.join(legacyRoot, key))) {
            stranded.push(key);
        }
    }
    return stranded;
}

module.exports = { legacyRootOf, findStrandedAssets };
