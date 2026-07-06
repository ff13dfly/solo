/**
 * End-to-end Verification for Gemini Integration
 * This script tests if the 'agent.image.ps' logic correctly uses the 
 * updated Gemini configuration and verified model.
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const Methods = require('../../logic');
const fs = require('fs');
const path = require('path');

async function verify() {
    console.log('🚀 Starting end-to-end verification...');
    console.log('Current AI_PROVIDER:', process.env.AI_PROVIDER);

    const testImagePath = path.join(__dirname, 'temp_resized/01-商品正面.JPG');
    if (!fs.existsSync(testImagePath)) {
        console.error('❌ Test image not found at:', testImagePath);
        return;
    }

    const imageBuffer = fs.readFileSync(testImagePath);
    const base64Image = imageBuffer.toString('base64');

    try {
        console.log('📡 Calling agent.image.ps through logic layer...');
        const result = await Methods.agent.image.ps({
            image: base64Image,
            prompt: '去除背景，替换为纯白色背景，保持商品清晰'
        });

        if (result.success && result.image) {
            console.log('✅ Integration Successful!');
            console.log('Provider used:', result.metadata?.provider);
            console.log('Model used:', result.metadata?.model);
            
            const outputPath = path.join(__dirname, 'verify_output.jpg');
            fs.writeFileSync(outputPath, Buffer.from(result.image, 'base64'));
            console.log('🎨 Result saved to:', outputPath);
        } else {
            console.error('❌ Integration failed: No image in response');
            console.error(JSON.stringify(result, null, 2));
        }
    } catch (error) {
        console.error('❌ Integration Error:', error.message);
        if (error.stack) console.error(error.stack);
    }
}

verify();
