const fs = require('fs');
const path = require('path');
const GeminiProvider = require('../../providers/gemini');
const QwenProvider = require('../../providers/qwen');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

/**
 * Image Classification Test
 * Compare Gemini 1.5 Flash vs Qwen-VL-Plus/Max
 * 
 * Target: Match real product images with ERP category codes
 */

async function runTest() {
    console.log('--- Agent Image Classification Test ---');

    const config = {
        geminiApiKey: process.env.GEMINI_API_KEY,
        qwenApiKey: process.env.DASHSCOPE_API_KEY,
        language: 'zh'
    };

    const gemini = new GeminiProvider(config);
    const qwen = new QwenProvider(config);

    // 1. Load Categories from ERP JSON
    const categoryPath = path.resolve(__dirname, '../../../../../import/erp/2026-存货分类-flat.json');
    if (!fs.existsSync(categoryPath)) {
        console.error(`❌ Category file not found: ${categoryPath}`);
        return;
    }
    
    const allCategories = JSON.parse(fs.readFileSync(categoryPath, 'utf-8'));
    
    // Pick a subset to keep the prompt clean and focused
    const subsetCodes = ['EA01', 'EA02', 'SC02', 'SC01', 'EH', 'LC02', 'LA01', 'HB03', 'HG'];
    const categorySubset = allCategories.filter(c => subsetCodes.includes(c.code));

    console.log(`✅ Loaded ${categorySubset.length} candidate categories for the test.`);

    // 2. Select Test Images
    const sampleDir = path.resolve(__dirname, '../samples');
    const images = [
        { path: path.join(sampleDir, 'tensor/sample.png'), desc: 'Terminal Block (接线端子)' },
        { path: path.resolve(__dirname, '../../../../../import/测试图片/01-商品正面.JPG'), desc: 'TPON Controller (控制器)' },
        { path: path.resolve(__dirname, '../../../../../import/测试图片/货品实物.jpg'), desc: 'Carton of Sockets (插座包装)' },
        { path: path.resolve(__dirname, '../../../../../import/测试图片/barcode.jpeg'), desc: 'Label/Barcode (标签)' },
        { path: path.resolve(__dirname, '../../../../../import/测试图片/货品实物.jpg'), desc: 'Duplicate test' } // Just as filler for now
    ];

    // 3. Define the Task
    const systemPrompt = `你是一个专业的仓储物资分类专家。我会给你一张商品图片，请从以下候选分类中选择最匹配的一个。
只能输出选中的分类编号(code)和名称(name)，格式为 JSON: {"code": "...", "name": "..."}。

候选分类列表:
${JSON.stringify(categorySubset.map(c => ({ code: c.code, name: c.name })), null, 2)}`;

    for (const img of images) {
        console.log(`\n=========================================`);
        console.log(`[Test] Image: ${path.basename(img.path)} (${img.desc})`);
        console.log(`=========================================`);

        if (!fs.existsSync(img.path)) {
            console.error(`❌ File not found: ${img.path}`);
            continue;
        }

        const base64 = fs.readFileSync(img.path).toString('base64');

        // --- Gemini Test ---
        console.log(`[Gemini] Classifying...`);
        try {
            const start = Date.now();
            const res = await gemini.classifyImage({
                image: base64,
                categories: categorySubset,
                model: 'gemini-2.5-flash'
            });
            console.log(`✅ Gemini (${Date.now() - start}ms): ${res.categoryId} - ${res.categoryName} (${(res.confidence * 100).toFixed(1)}%)`);
            console.log(`   Reason: ${res.reason}`);
        } catch (e) {
            console.error(`❌ Gemini Failed: ${e.message}`);
        }

        // --- Qwen Test ---
        console.log(`[Qwen] Classifying...`);
        try {
            const start = Date.now();
            const res = await qwen.classifyImage({
                image: base64,
                categories: categorySubset.map(c => ({ id: c.code, label: { zh: c.name } })),
                model: 'qwen-vl-plus'
            });
            console.log(`✅ Qwen (${Date.now() - start}ms): ${res.categoryId} - ${res.categoryName} (${(res.confidence * 100).toFixed(1)}%)`);
            console.log(`   Reason: ${res.reason}`);
        } catch (e) {
            console.error(`❌ Qwen Failed: ${e.message}`);
        }
    }
}

runTest().catch(console.error);
