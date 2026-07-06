const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const src = path.resolve(__dirname, './sample/0e4f12a87864d01283a89e82a1fb2bde2b8e33d221db80f1d037db34ce.jpg');
const dest = path.resolve(__dirname, './sample.png');

async function prepare() {
    if (!fs.existsSync(src)) {
        console.error('Source not found');
        return;
    }
    await sharp(src)
        .resize(800, 800, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
        .png()
        .toFile(dest);
    console.log('✅ Created sample.png');
}

prepare().catch(console.error);
