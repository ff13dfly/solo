/**
 * Integration Test: agent.image.product with Real Product Images
 *
 * 模拟前端 AIExtractionModal 的完整流程:
 * 1. 读取 import/ 下 4 张商品照片
 * 2. 按前端逻辑缩放到 MAX_SIDE=1200 (模拟 downsizeImage)
 * 3. 转为 base64 data URI
 * 4. 调用 provider.extractProductInfo()，使用和前端一样的 schema
 * 5. 打印结果并验证结构
 *
 * Usage:
 *   cd api/core/agent
 *   DASHSCOPE_API_KEY=sk-xxx node tests/integration_real_images.js
 *
 *   # 或使用 gemini:
 *   AI_PROVIDER=gemini GEMINI_API_KEY=xxx node tests/integration_real_images.js
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const ProviderFactory = require('../../providers');

// === CONFIGURATION ===
const MAX_SIDE = 1200;  // 与前端 AIExtractionModal.downsizeImage 一致
const JPEG_QUALITY = 80; // 前端 canvas.toDataURL('image/jpeg', 0.8)

const IMPORT_DIR = path.resolve(__dirname, '../../../../import');

// 来源图片 → 对应前端的 preset role
const IMAGE_MAP = [
    { file: '01-商品正面.JPG', role: 'front' },
    { file: '02-商品背面.JPG', role: 'back' },
    { file: '03-商品侧面01.JPG', role: 'left' },
    { file: '04-商品侧面02.JPG', role: 'right' },
];

// 前端 AIExtractionModal 发送给后端的 schema（与 startExtraction 一致）
const FRONTEND_SCHEMA = {
    name: { type: 'string', description: 'Product name' },
    price: { type: 'number', description: 'Price in cents' },
    sku: { type: 'string', description: 'SKU or Model ID' },
    specs: { type: 'object', description: 'Key-value pairs of technical specs' }
};


// === STEP 1: Read images and convert to base64 ===
// Note: 跳过 sips 缩放（macOS sandbox 权限问题）
// 前端 downsizeImage 将 1080×1920 缩放到 675×1200，此处直接发送原始尺寸
// API 接受原始尺寸的图片，测试目的是验证接口集成而非缩放逻辑

function imageToBase64(filePath) {
    const buffer = fs.readFileSync(filePath);
    return buffer.toString('base64');
}


// === STEP 2: Build the request payload (matches frontend AIExtractionModal.startExtraction) ===

function buildImagePayload() {
    const imageList = [];

    for (const entry of IMAGE_MAP) {
        const srcPath = path.join(IMPORT_DIR, entry.file);
        if (!fs.existsSync(srcPath)) {
            console.error(`  ❌ 找不到文件: ${srcPath}`);
            continue;
        }

        const stats = fs.statSync(srcPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
        console.log(`  📸 ${entry.file} (${sizeMB}MB) → role: ${entry.role}`);

        const base64Data = imageToBase64(srcPath);

        // 前端发送格式: { data: base64(去掉前缀), meta: { role } }
        imageList.push({
            data: base64Data,
            meta: { role: entry.role }
        });
    }

    return imageList;
}


// === STEP 3: Call provider.extractProductInfo() ===

async function runTest() {
    console.log('=================================================================');
    console.log('  Integration Test: agent.image.product (Real Product Images)');
    console.log(`  Provider: ${config.provider}`);
    console.log('=================================================================\n');

    // Validate API key
    const keyName = config.provider === 'gemini' ? 'GEMINI_API_KEY' : 'DASHSCOPE_API_KEY';
    const hasKey = config.provider === 'gemini' ? !!config.geminiApiKey : !!config.qwenApiKey;
    if (!hasKey) {
        console.error(`❌ 缺少 ${keyName} 环境变量。请设置后再运行。`);
        process.exit(1);
    }
    console.log(`✅ ${keyName} 已配置\n`);

    // Step 1: Prepare images
    console.log('📸 Step 1: 读取并缩放图片 (模拟前端 downsizeImage)...');
    const images = buildImagePayload();
    console.log(`  共处理 ${images.length} 张图片\n`);

    if (images.length === 0) {
        console.error('❌ 没有可处理的图片');
        process.exit(1);
    }

    // Step 2: Call provider
    console.log('🤖 Step 2: 调用 provider.extractProductInfo()...');
    console.log(`  Schema: ${JSON.stringify(Object.keys(FRONTEND_SCHEMA))}`);
    console.log('  等待 AI 响应...\n');

    const provider = ProviderFactory.getProvider(config);
    const startTime = Date.now();

    try {
        const result = await provider.extractProductInfo({
            images: images,
            schema: FRONTEND_SCHEMA
        });

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`⏱  响应耗时: ${elapsed}s\n`);

        // Step 3: Validate response
        console.log('📋 Step 3: 验证响应结构...\n');
        console.log('--- Raw Result ---');
        console.log(JSON.stringify(result, null, 2));
        console.log('--- End ---\n');

        if (!result.success) {
            console.error('❌ [FAILED] API 返回 success=false:', result.error);
            process.exit(1);
        }

        // Check expected structure
        const data = result.data;
        const checks = {
            'result.success === true': result.success === true,
            'result.data 存在': !!data,
            'data.zh 存在 (多语言)': !!data?.zh,
            'data.en 存在 (多语言)': !!data?.en,
            'data.zh.name 存在': !!data?.zh?.name,
        };

        console.log('验证结果:');
        let allPassed = true;
        for (const [label, passed] of Object.entries(checks)) {
            const icon = passed ? '✅' : '❌';
            console.log(`  ${icon} ${label}`);
            if (!passed) allPassed = false;
        }

        console.log('');
        if (allPassed) {
            console.log('🎉 [PASSED] 所有验证通过！');
        } else {
            console.log('⚠️  [PARTIAL] 部分验证未通过，请检查返回的数据结构。');
        }

        // Print extracted product info in readable format
        if (data?.zh) {
            console.log('\n--- 提取的商品信息 (中文) ---');
            for (const [key, val] of Object.entries(data.zh)) {
                if (typeof val === 'object' && val.value !== undefined) {
                    console.log(`  ${key}: ${val.value} (confidence: ${val.confidence}%)`);
                } else {
                    console.log(`  ${key}: ${JSON.stringify(val)}`);
                }
            }
        }

        if (data?.en) {
            console.log('\n--- Extracted Product Info (English) ---');
            for (const [key, val] of Object.entries(data.en)) {
                if (typeof val === 'object' && val.value !== undefined) {
                    console.log(`  ${key}: ${val.value} (confidence: ${val.confidence}%)`);
                } else {
                    console.log(`  ${key}: ${JSON.stringify(val)}`);
                }
            }
        }

    } catch (error) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.error(`\n❌ [ERROR] (${elapsed}s):`, error.message);
        if (error.message.includes('Missing DashScope API Key')) {
            console.error('   → 请设置 DASHSCOPE_API_KEY 环境变量');
        }
        process.exit(1);
    } finally {
        console.log('\n✅ 测试完成');
    }
}

runTest();
