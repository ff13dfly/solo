/**
 * test_banana_ps.js
 * 测试 Bitexing banana 图像处理：商品图 → 白底电商主图
 */
try { require('dotenv').config({ path: require('path').join(__dirname, '../../.env') }); } catch (e) {}

const fs = require('fs');
const path = require('path');

async function main() {
    const BitexingProvider = require('../../providers/bitexing');

    const config = {
        bitexingApiKey: process.env.BITEXING_API_KEY,
        bitexingBaseUrl: process.env.BITEXING_BASE_URL || 'https://bitexingai.com/v1',
        language: 'zh',
    };

    if (!config.bitexingApiKey) {
        console.error('❌ BITEXING_API_KEY 未配置');
        process.exit(1);
    }

    const imgPath = path.join(__dirname, '../../../../import/测试图片/01-商品正面.JPG');
    if (!fs.existsSync(imgPath)) {
        console.error('❌ 图片不存在:', imgPath);
        process.exit(1);
    }

    const imgBase64 = fs.readFileSync(imgPath).toString('base64');
    console.log(`✅ 图片已读取，大小: ${Math.round(imgBase64.length / 1024)}KB`);

    const provider = new BitexingProvider(config);

    // gemini-3.1-flash-image-preview 走 chat completions 输出图像
    const OpenAI = require('openai');
    const client = new OpenAI({
        apiKey: config.bitexingApiKey,
        baseURL: config.bitexingBaseUrl,
    });

    const model = 'gemini-3.1-flash-image-preview';
    console.log(`🚀 调用 chat completions (${model})...`);

    const response = await client.chat.completions.create({
        model,
        messages: [
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: '请去除图片背景，替换为纯白色背景，保持商品完整清晰，输出适合电商平台的主图。直接输出处理后的图片，不要文字说明。',
                    },
                    {
                        type: 'image_url',
                        image_url: { url: `data:image/jpeg;base64,${imgBase64}` },
                    },
                ],
            },
        ],
        // 请求图像输出
        modalities: ['text', 'image'],
    });

    console.log('📦 响应结构:', JSON.stringify(response.choices?.[0]?.message, null, 2).slice(0, 500));

    // 尝试从响应中提取图像 base64
    const msg = response.choices?.[0]?.message;
    let imageB64 = null;

    if (Array.isArray(msg?.content)) {
        for (const part of msg.content) {
            if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:')) {
                imageB64 = part.image_url.url.replace(/^data:image\/\w+;base64,/, '');
                break;
            }
            if (part.type === 'image' && part.source?.data) {
                imageB64 = part.source.data;
                break;
            }
        }
    }

    if (!imageB64) {
        console.log('⚠️  响应中未找到图像数据，完整响应:');
        console.log(JSON.stringify(response, null, 2).slice(0, 1000));
        process.exit(1);
    }

    const outPath = path.join(__dirname, 'output_white_bg.jpg');
    fs.writeFileSync(outPath, Buffer.from(imageB64, 'base64'));
    console.log(`✅ 完成！已保存到: ${outPath}`);
}

main().catch(e => {
    console.error('❌ 错误:', e.message || e);
    process.exit(1);
});
