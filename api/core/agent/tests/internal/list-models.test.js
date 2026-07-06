const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require('path');
const dotenv = require('dotenv');

const agentEnv = path.resolve(__dirname, '../../.env');
dotenv.config({ path: agentEnv });

async function listModels() {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    // There isn't a direct listModels in the client SDK usually, 
    // but we can try to fetch them or just try a few common ones with v1
    console.log('Testing text-embedding-004 on v1...');
    try {
        const model = genAI.getGenerativeModel({ model: "text-embedding-004" }, { apiVersion: 'v1' });
        const res = await model.embedContent("test");
        console.log('✅ text-embedding-004 works on v1!');
    } catch (e) {
        console.log('❌ text-embedding-004 failed on v1:', e.message);
    }

    console.log('\nTesting embedding-001 on v1...');
    try {
        const model = genAI.getGenerativeModel({ model: "embedding-001" }, { apiVersion: 'v1' });
        const res = await model.embedContent("test");
        console.log('✅ embedding-001 works on v1!');
    } catch (e) {
        console.log('❌ embedding-001 failed on v1:', e.message);
    }
}

listModels().catch(console.error);
