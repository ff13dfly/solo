
const redis = require('redis');

async function run() {
    const client = redis.createClient();
    await client.connect();
    
    console.log('Fetching SYSTEM:REGISTRY:CATEGORIES...');
    const categories = await client.hGetAll('SYSTEM:REGISTRY:CATEGORIES');
    
    console.log('Found categories:', Object.keys(categories));
    
    if (categories['HR']) {
        console.log('HR Entry:', JSON.stringify(JSON.parse(categories['HR']), null, 2));
    } else {
        console.log('HR key NOT found in registry.');
    }
    
    await client.disconnect();
}

run().catch(console.error);
