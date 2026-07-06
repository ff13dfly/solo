
const fetch = require('node-fetch');

const URL = 'http://localhost:3820/jsonrpc';
const ID = 'test_synonyms_persistence_' + Date.now();

async function call(method, params) {
    const res = await fetch(URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method,
            params,
            id: 1
        })
    });
    return res.json();
}

async function run() {
    console.log('Creating workflow:', ID);
    let res = await call('orchestrator.workflow.create', {
        id: ID,
        name: 'Test Synonyms',
        desc: 'Testing persistence',
        category: 'Test',
        steps: [{ id: 's1', service: 'test', method: 'test.run', params: {} }]
    });
    
    if (res.error) console.error('Create error:', res.error);

    console.log('Updating with synonyms...');
    const synonyms = {
        "roomId": ["room", "place"],
        "userId": ["user"]
    };
    
    res = await call('orchestrator.workflow.update', {
        id: ID,
        synonyms
    });

    if (res.error) console.error('Update error:', res.error);
    else console.log('Update result:', JSON.stringify(res.result.synonyms));

    console.log('Fetching back...');
    res = await call('orchestrator.workflow.get', { id: ID });
    
    if (res.error) console.error('Get error:', res.error);
    else {
        const savedSynonyms = res.result.synonyms;
        console.log('Fetched synonyms:', JSON.stringify(savedSynonyms));
        
        if (JSON.stringify(savedSynonyms) === JSON.stringify(synonyms)) {
            console.log('SUCCESS: Synonyms persisted correctly.');
        } else {
            console.error('FAILURE: Synonyms mismatch.');
        }
    }

    // Cleanup
    await call('orchestrator.workflow.delete', { id: ID });
}

run().catch(console.error);
