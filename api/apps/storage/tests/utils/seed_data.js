const { createClient } = require('redis');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');

async function seed() {
    const redis = createClient({ url: config.redisUrl });
    await redis.connect();
    console.log('Redis connected for seeding');

    // Create upload dir if missing
    if (!fs.existsSync(config.uploadDir)) {
        fs.mkdirSync(config.uploadDir, { recursive: true });
    }

    // Seed a few mock assets
    const mockAssets = [
        { name: 'logo.png', content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==' },
        { name: 'test.txt', content: Buffer.from('Hello Solo Storage').toString('base64') }
    ];

    for (const asset of mockAssets) {
        const buffer = Buffer.from(asset.content, 'base64');
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const assetId = sha256.substring(0, config.idLengths.asset);
        
        // Save file locally (primitive mock)
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
        console.log(`Seeded asset: ${asset.name} (${assetId})`);
    }

    await redis.quit();
}

seed().catch(console.error);
