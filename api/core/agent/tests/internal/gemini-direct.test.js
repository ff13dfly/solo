const axios = require('axios');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "text-embedding-004";

async function testDirect() {
    console.log(`Testing $MODEL via Direct Axios...`);
    try {
        const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL}:embedContent?key=${API_KEY}`;
        const res = await axios.post(url, {
            content: { parts: [{ text: "test" }] }
        });
        console.log('✅ Success!');
        console.log('Response:', JSON.stringify(res.data, null, 2));
    } catch (e) {
        console.error('❌ Failed:', e.response?.data || e.message);
    }
}

testDirect();
