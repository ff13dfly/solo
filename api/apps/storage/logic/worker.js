const { parentPort } = require('worker_threads');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
let sharp;
try { sharp = require('sharp'); } catch (_) { sharp = null; }

parentPort.on('message', async (task) => {
    const { taskId, type, payload } = task;

    try {
        if (type === 'HASH') {
            const { buffer } = payload;
            const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
            parentPort.postMessage({ taskId, type: 'HASH_RESULT', payload: { sha256 } });
        }
        else if (type === 'THUMBNAIL') {
            const { srcPath, sizes, quality, destPaths } = payload;
            if (!sharp) {
                return parentPort.postMessage({ taskId, type: 'ERROR', payload: 'Sharp not installed' });
            }

            const results = await Promise.all(Object.entries(sizes).map(async ([label, px]) => {
                const destPath = destPaths[label];
                if (!destPath) return { label, status: 'skipped' };

                if (fs.existsSync(destPath)) return { label, status: 'exists' };

                // Ensure directory exists for the thumbnail
                const destDir = path.dirname(destPath);
                if (!fs.existsSync(destDir)) {
                    fs.mkdirSync(destDir, { recursive: true });
                }

                await sharp(srcPath)
                    .resize(px, px, { fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality })
                    .toFile(destPath);

                return { label, status: 'created' };
            }));

            parentPort.postMessage({ taskId, type: 'THUMBNAIL_RESULT', payload: { results } });
        }
    } catch (err) {
        parentPort.postMessage({ taskId, type: 'ERROR', payload: err.message });
    }
});
