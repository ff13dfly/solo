const axios = require('axios');

async function testCases() {
    try {
        const response = await axios.post('http://localhost:8730/jsonrpc', {
            jsonrpc: '2.0',
            method: 'agent.cases',
            params: {
                workflow_id: 'C5y95L',
                count: 3
            },
            id: 1
        });

        console.log('Response:', JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
}

testCases();
