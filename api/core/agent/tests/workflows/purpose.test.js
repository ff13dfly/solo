const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const fs = require('fs');
const config = require('../../config');
const QwenProvider = require('../../providers/qwen');
const CapabilityManager = require('../../logic/capability');

// Ensure API Key is present for this script if not loaded by config
if (!config.qwenApiKey && process.env.DASHSCOPE_API_KEY) {
    config.qwenApiKey = process.env.DASHSCOPE_API_KEY;
}

const qwen = new QwenProvider(config);

async function runTests() {
    console.log('[Test] Starting Purpose Detection Tests...');

    // 1. Fetch Capabilities
    console.log('[Test] Fetching Capabilities...');
    const capabilities = await CapabilityManager.getCapabilities();
    console.log(`[Test] Got ${capabilities.length} capabilities.`);

    // 2. Read Test File
    const testFile = path.join(__dirname, 'purpose_detect.txt');
    const content = fs.readFileSync(testFile, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim() !== '');

    console.log(`[Test] Found ${lines.length} test cases.`);

    const results = [];

    // 3. Process each line
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        console.log(`\n[Case ${i + 1}] Processing: "${line}"`);
        
        try {
            const start = Date.now();
            const response = await qwen.identifyPurpose({
                text: line,
                capabilities: capabilities,
                model: 'qwen-turbo' // Using turbo for speed/cost, or use qwen-max if needed
            });
            const duration = Date.now() - start;

            const result = response.result || response.error;
            console.log(`[Case ${i + 1}] Result: ${JSON.stringify(result)} (${duration}ms)`);

            results.push({
                input: line,
                result: result,
                prompt: "(System Prompt Hidden for Brevity)", // We know the prompt logic
            });

        } catch (error) {
            console.error(`[Case ${i + 1}] Error:`, error.message);
            results.push({
                input: line,
                error: error.message
            });
        }
    }

    // 4. Generate Markdown
    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const mdContent = generateMarkdown(results, capabilities);
    
    // Output to stdout for capture
    console.log('\n--- MARKDOWN OUTPUT START ---');
    console.log(mdContent);
    console.log('--- MARKDOWN OUTPUT END ---');

    // Clean up Redis
    if (CapabilityManager.redisClient.isOpen) {
        await CapabilityManager.redisClient.quit();
    }
}

function generateMarkdown(results, capabilities) {
    const today = new Date().toISOString().split('T')[0];
    let md = `# Purpose Detection Analysis Results
Date: ${today}
Source: \`api/agent/tests/purpose_detect.txt\`
Provider: Qwen (qwen-turbo)

## System Capabilities (from Redis)
${capabilities.map(c => `- ${c.name}: ${c.desc}`).join('\n')}

---

## Test Cases & Results

`;

    results.forEach((item, index) => {
        md += `### Case ${index + 1}
**Input**: 
> ${item.input}

**Detected Result**:
\`\`\`json
${JSON.stringify(item.result, null, 2)}
\`\`\`

---

`;
    });

    return md;
}

runTests();
