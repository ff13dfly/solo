const { createClient } = require('redis');

async function checkRedis() {
    const client = createClient({ url: 'redis://localhost:6379' });
    await client.connect();
    
    const keys = await client.keys('*');
    console.log('Total keys in Redis:', keys.length);
    
    for (const key of keys) {
        const type = await client.type(key);
        if (key.includes('asset') || key.includes('storage')) {
             console.log(`Key: ${key}, Type: ${type}`);
             if (type === 'hash') {
                 const val = await client.hGetAll(key);
                 console.log('Value:', val);
             } else if (type === 'string') {
                 const val = await client.get(key);
                 console.log('Value:', val);
             } else if (type === 'set') {
                 const val = await client.sMembers(key);
                 console.log('Value:', val);
             }
        }
    }
    
    await client.disconnect();
}

checkRedis().catch(console.error);
