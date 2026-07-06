const fs = require('fs');
const path = require('path');
const GeminiProvider = require('../../providers/gemini');
const QwenProvider = require('../../providers/qwen');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

/**
 * Product Info Extraction Test
 * Extract detailed descriptions from images and save results.
 */

async function runTest() {
    console.log('--- Agent Product Info Extraction Test ---');

    const config = {
        geminiApiKey: process.env.GEMINI_API_KEY,
        qwenApiKey: process.env.DASHSCOPE_API_KEY,
        language: 'zh'
    };

    const gemini = new GeminiProvider(config);
    const qwen = new QwenProvider(config);

    const testImages = [
        { path: path.resolve(__dirname, '../../../../../import/测试图片/01-商品正面.JPG'), name: 'controller_front' },
        { path: path.resolve(__dirname, '../../../../../import/测试图片/货品实物.jpg'), name: 'socket_carton' },
        { path: path.resolve(__dirname, '../../../../../import/测试图片/barcode.jpeg'), name: 'electrical_label' }
    ];

    const resultsDir = path.resolve(__dirname, '../results');
    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

    let reportMd = `# 商品详情提取测试报告\n\n生成时间: ${new Date().toLocaleString()}\n\n`;

    for (const img of testImages) {
        console.log(`\nProcessing: ${path.basename(img.path)}...`);
        if (!fs.existsSync(img.path)) {
            console.error(`❌ File not found: ${img.path}`);
            continue;
        }

        const base64 = fs.readFileSync(img.path).toString('base64');
        
        // Use a generic schema for extraction
        const schema = {
            name: "商品名称",
            brand: "品牌",
            specs: "规格参数 (如电压、功率、型号等)",
            description: "详细详情说明 (包括卖点、用途等)"
        };

        reportMd += `## 样张: ${path.basename(img.path)}\n\n`;
        reportMd += `![${img.name}](file://${img.path})\n\n`;

        // --- Gemini ---
        console.log(`[Gemini] Extracting...`);
        try {
            const res = await gemini.extractProductInfo({
                images: [{ data: base64 }],
                schema,
                model: 'gemini-2.5-flash'
            });
            const data = res.data?.zh || {};
            reportMd += `### [Gemini 2.5 Flash] 结果\n`;
            reportMd += `- **名称**: ${data.name?.value || 'N/A'}\n`;
            reportMd += `- **品牌**: ${data.brand?.value || 'N/A'}\n`;
            reportMd += `- **规格**: ${data.specs?.value || 'N/A'}\n`;
            reportMd += `- **详情**: ${data.description?.value || 'N/A'}\n\n`;
        } catch (e) {
            reportMd += `### [Gemini] 失败: ${e.message}\n\n`;
        }

        // --- Qwen ---
        console.log(`[Qwen] Extracting...`);
        try {
            const res = await qwen.extractProductInfo({
                images: [{ data: base64 }],
                schema,
                model: 'qwen-vl-plus'
            });
            const data = res.data?.zh || {};
            reportMd += `### [Qwen-VL-Plus] 结果\n`;
            reportMd += `- **名称**: ${data.name?.value || 'N/A'}\n`;
            reportMd += `- **品牌**: ${data.brand?.value || 'N/A'}\n`;
            reportMd += `- **规格**: ${data.specs?.value || 'N/A'}\n`;
            reportMd += `- **详情**: ${data.description?.value || 'N/A'}\n\n`;
        } catch (e) {
            reportMd += `### [Qwen] 失败: ${e.message}\n\n`;
        }

        reportMd += `---\n\n`;
    }

    const reportPath = path.join(resultsDir, 'extraction_report.md');
    fs.writeFileSync(reportPath, reportMd);
    console.log(`\n✅ Test Complete. Report saved to: ${reportPath}`);
}

runTest().catch(console.error);
