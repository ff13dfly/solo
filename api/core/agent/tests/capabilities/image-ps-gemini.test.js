/**
 * test_gemini_ps.js
 * 测试官方 Gemini API 图像生成/修图能力（responseModalities: IMAGE）
 */
try { require('dotenv').config({ path: require('path').join(__dirname, '../../.env') }); } catch (e) {}

const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function main() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { console.error('❌ GEMINI_API_KEY 未配置'); process.exit(1); }

    const imgPath = path.join(__dirname, '../../../../import/测试图片/01-商品正面.JPG');
    const imgBase64 = fs.readFileSync(imgPath).toString('base64');
    console.log(`✅ 图片已读取，大小: ${Math.round(imgBase64.length / 1024)}KB`);

    const genAI = new GoogleGenerativeAI(apiKey);

    // gemini-2.5-flash-image 支持图像输出
    const model = genAI.getGenerativeModel({
        model: 'gemini-3.1-flash-image-preview',
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
        },
    });

    console.log('🚀 调用 Gemini (gemini-2.5-flash-image) 图像生成...');

    const result = await model.generateContent([
        '请去除图片背景，替换为纯白色背景，保持商品完整清晰，输出适合电商平台的主图。',
        {
            inlineData: {
                data: imgBase64,
                mimeType: 'image/jpeg',
            },
        },
    ]);

    const response = result.response;
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    console.log(`📦 响应 parts 数量: ${parts.length}`);

    let imageB64 = null;
    let mimeType = 'image/png';
    for (const part of parts) {
        if (part.inlineData?.data) {
            imageB64 = part.inlineData.data;
            mimeType = part.inlineData.mimeType || 'image/png';
            break;
        }
        if (part.text) console.log('📝 文本:', part.text.slice(0, 100));
    }

    if (!imageB64) {
        console.error('❌ 响应中无图像数据');
        console.log('完整 parts:', JSON.stringify(parts, null, 2).slice(0, 800));
        process.exit(1);
    }

    const ext = mimeType.includes('png') ? 'png' : 'jpg';
    const outPath = path.join(__dirname, `output_gemini_white_bg.${ext}`);
    fs.writeFileSync(outPath, Buffer.from(imageB64, 'base64'));
    console.log(`✅ 完成！已保存到: ${outPath}`);
    console.log(`   mimeType: ${mimeType}, 大小: ${Math.round(imageB64.length / 1024)}KB`);
}

main().catch(e => {
    console.error('❌ 错误:', e.message || e);
    process.exit(1);
});
