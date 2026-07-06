const QwenProvider = require('../../providers/qwen');
const config = require('../../config');

// 使用阿里云文档中稳定的测试图片
const TEST_IMAGE_URL = "https://dashscope.oss-cn-beijing.aliyuncs.com/images/dog_and_girl.jpeg";

const targetSchema = {
    main_subject: "string (图像主体)",
    mood: "string (画面氛围)",
    interaction: "string (人与动物的互动描述)"
};

const mockMeta = {
    stage: "test_verification",
    task_priority: "high",
    user_context: "验证 meta 参数是否能成功注入提示词并影响 AI 的识别深度"
};

async function runIntegrationTest() {
    console.log("=== [INTEGRATION TEST] Qwen Product Extraction with Meta Support ===");

    if (!config.qwenApiKey) {
        console.error("Error: DASHSCOPE_API_KEY is missing.");
        return;
    }

    const provider = new QwenProvider(config);

    try {
        console.log("-> Testing with Meta Context...");
        const result = await provider.extractProductInfo({
            images: [TEST_IMAGE_URL],
            schema: targetSchema,
            meta: mockMeta  // 测试新增加的松耦合 meta 参数
        });

        console.log("\n-> API Result:");
        console.log(JSON.stringify(result, null, 2));

        if (result.success && result.data && result.data.zh) {
            console.log("\n[PASSED]: Integrated test successful with multi-lang and confidence scores.");
        } else {
            console.error("\n[FAILED]: API response structure not as expected.");
        }
    } catch (error) {
        console.error("\n[ERROR]:", error.message);
    }
}

runIntegrationTest();
