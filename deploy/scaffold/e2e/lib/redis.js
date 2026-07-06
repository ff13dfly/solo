/**
 * Redis helpers — connect to the dev/test instance (6699 by default) and scan.
 * Suites use this to inject permits (§5 lever) and read back records (§8).
 */
const { createClient } = require('redis');
const { read } = require('./context');

async function connect(url) {
    const client = createClient({ url: url || read().redisUrl || 'redis://localhost:6699' });
    client.on('error', () => { /* swallow — tests assert via explicit reads */ });
    await client.connect();
    return client;
}

/** SCAN the whole keyspace (or a pattern) into a flat array of key strings. */
async function scanAll(redis, pattern = '*') {
    const keys = [];
    for await (const entry of redis.scanIterator({ MATCH: pattern, COUNT: 500 })) {
        // node-redis v4 yields a string per key; some minors yield batches — handle both.
        if (Array.isArray(entry)) keys.push(...entry);
        else keys.push(entry);
    }
    return keys;
}

module.exports = { connect, scanAll };
