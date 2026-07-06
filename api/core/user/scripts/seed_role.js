const redis = require('redis');

async function seed() {
    console.log('Connecting to Redis...');
    const client = redis.createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379'
    });
    
    client.on('error', err => console.error('Redis Error:', err));
    await client.connect();

    const key = 'USER:CONFIG:CATEGORY:role';
    const data = [
        {
            id: 'normal',
            label: { zh: '普通用户', en: 'Normal User' },
            desc: 'Standard system user',
            createdAt: Date.now()
        },
        {
            id: 'operator',
            label: { zh: '运维人员', en: 'Operator' },
            desc: 'System maintenance personnel',
            createdAt: Date.now()
        }
    ];

    console.log(`Writing to key: ${key}`);
    await client.set(key, JSON.stringify(data));
    
    console.log('Data written successfully:');
    console.log(JSON.stringify(data, null, 2));

    await client.quit();
}

seed().catch(console.error);
