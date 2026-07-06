const fs = require('fs');
const path = require('path');
const GeminiProvider = require('../../providers/gemini');
const QwenProvider = require('../../providers/qwen');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

async function testAudio() {
    console.log('--- Agent Audio Transcription Test ---');

    const config = {
        geminiApiKey: process.env.GEMINI_API_KEY,
        language: 'zh'
    };

    if (!config.geminiApiKey) {
        console.error('❌ GEMINI_API_KEY not configured in .env');
        return;
    }

    const gemini = new GeminiProvider(config);
    const qwen = new QwenProvider({ ...config, qwenApiKey: process.env.DASHSCOPE_API_KEY });
    
    const audioFiles = [
        path.resolve(__dirname, '../../../../../import/测试音频/french_order.m4a'),
        path.resolve(__dirname, '../../../../../import/测试音频/french_order_items.m4a')
    ];

    for (const audioPath of audioFiles) {
        console.log(`\n=========================================`);
        console.log(`[Test] Processing: ${path.basename(audioPath)}`);
        console.log(`=========================================`);
        
        if (!fs.existsSync(audioPath)) {
            console.error(`❌ File not found: ${audioPath}`);
            continue;
        }

        const audioBase64 = fs.readFileSync(audioPath).toString('base64');

        // 1. Gemini Test
        console.log('\n[Gemini] Starting...');
        try {
            const start = Date.now();
            const result = await gemini.transcribeAudio({ audio: audioBase64, mimeType: 'audio/m4a' });
            console.log(`✅ Gemini (${Date.now() - start}ms): ${JSON.stringify(result.text)}`);
        } catch (e) {
            console.error('❌ Gemini Failed:', e.message);
        }

        // 2. Qwen Test
        console.log('\n[Qwen] Starting...');
        try {
            const start = Date.now();
            const result = await qwen.transcribeAudio({ audio: audioBase64, mimeType: 'audio/m4a' });
            console.log(`✅ Qwen (${Date.now() - start}ms): ${JSON.stringify(result.text)}`);
        } catch (e) {
            console.error('❌ Qwen Failed:', e.message);
        }
    }
}

testAudio();
