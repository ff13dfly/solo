const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const QwenProvider = require('../../providers/qwen');
const GeminiProvider = require('../../providers/gemini');

// Load env from agent root
const agentEnv = path.resolve(__dirname, '../../.env');
dotenv.config({ path: agentEnv });

const SAMPLE_IMAGE = path.resolve(__dirname, '../../samples/tensor/sample.png');
const OUTPUT_PATH = path.resolve(__dirname, 'tensor_token_report.json');

async function runComparison() {
    console.log('--- Tensor & Token Consumption Comparison Test ---');
    console.log(`Sample Image: ${SAMPLE_IMAGE}`);

    if (!fs.existsSync(SAMPLE_IMAGE)) {
        console.error('❌ Error: sample.png not found!');
        return;
    }

    const config = {
        qwenApiKey: process.env.DASHSCOPE_API_KEY,
        geminiApiKey: process.env.GEMINI_API_KEY,
        language: 'zh'
    };

    const qwen = new QwenProvider(config);
    const gemini = new GeminiProvider(config);

    const imageBase64 = fs.readFileSync(SAMPLE_IMAGE).toString('base64');
    const report = {
        timestamp: new Date().toISOString(),
        providers: {}
    };

    // --- Qwen Test ---
    console.log('\n[Qwen] Calling multimodal-embedding-v1...');
    try {
        const start = Date.now();
        const res = await qwen.getMultimodalEmbedding({ image: imageBase64 });
        report.providers.qwen = {
            success: true,
            latency_ms: Date.now() - start,
            dimension: res.embedding.length,
            tensor_head: res.embedding.slice(0, 5),
            usage: res.metadata.usage || { totalTokens: 'Unknown' }
        };
        console.log(`✅ Qwen Done. Tokens: ${JSON.stringify(report.providers.qwen.usage)}`);
    } catch (e) {
        console.error(`❌ Qwen Failed: ${e.message}`);
        report.providers.qwen = { success: false, error: e.message };
    }

    // --- Gemini Test (Direct Multimodal Embedding) ---
    console.log('\n[Gemini] Calling gemini-embedding-2...');
    try {
        const start = Date.now();
        const res = await gemini.getEmbedding({ image: imageBase64 });
        
        report.providers.gemini = {
            success: true,
            latency_ms: Date.now() - start,
            dimension: res.embedding.length,
            tensor_head: res.embedding.slice(0, 5),
            usage: { totalTokens: 'Unknown' } // Gemini embedding doesn't return usage in this SDK yet
        };
        console.log(`✅ Gemini Done. Dimension: ${res.embedding.length}`);
    } catch (e) {
        console.error(`❌ Gemini Failed: ${e.message}`);
        report.providers.gemini = { success: false, error: e.message };
    }

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
    console.log(`\n📄 Report saved to: ${OUTPUT_PATH}`);
}

runComparison().catch(console.error);
