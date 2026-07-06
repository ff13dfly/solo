const { createClient } = require('redis');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');

async function seed() {
    console.log('Starting Storage Mock Data Seeding...');
    const redis = createClient({ url: config.redisUrl });
    await redis.connect();

    if (!fs.existsSync(config.uploadDir)) {
        fs.mkdirSync(config.uploadDir, { recursive: true });
    }

    const mockAssets = [
        { name: 'sample-image.png', content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==' },
        { name: 'specification.txt', content: Buffer.from('Storage Compliance Test Data').toString('base64') }
    ];

    for (const asset of mockAssets) {
        const buffer = Buffer.from(asset.content, 'base64');
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const assetId = sha256.substring(0, config.idLengths.asset);
        
        const filePath = path.join(config.uploadDir, `${sha256}${path.extname(asset.name)}`);
        fs.writeFileSync(filePath, buffer);

        const metadata = {
            id: assetId,
            originalName: asset.name,
            mimeType: asset.name.endsWith('.png') ? 'image/png' : 'text/plain',
            sha256: sha256,
            size: buffer.length,
            path: `${sha256}${path.extname(asset.name)}`,
            createdAt: new Date().toISOString()
        };

        await redis.set(`${config.redis.assetPrefix}${assetId}`, JSON.stringify(metadata));
        await redis.sAdd(config.redis.assetIdSet, assetId);
        console.log(`✓ Seeded: ${asset.name} -> ${assetId}`);
    }

    await redis.quit();
    console.log('Seeding Complete.');
}

if (require.main === module) {
    seed().catch(err => {
        console.error('Seeding Failed:', err);
        process.exit(1);
    });
}

module.exports = seed;
