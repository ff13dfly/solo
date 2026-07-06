const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { createClient } = require('redis');
const jsonrpc = require('../handlers/jsonrpc');
const { createLogger } = require('../../../library/logger');

const logger = createLogger('administrator-identity');

let redisClient;
let sweepInterval;

// In-memory challenge store (Use Redis for production scaling)
const challengeStore = new Map();

/**
 * Load user from Redis with seed.json bootstrap.
 * 
 * @why Enables persistent user management via Redis while maintaining a 
 *      temporary "bootstrap" admin user in seed.json for initial setup.
 * @attention 
 *   1. ANTI-DOWNGRADE: Once seed.json is deleted, the system will NOT fall back 
 *      to any default/hardcoded passwords. If Redis is cleared, access is denied.
 *   2. SOURCE PRIORITY: Redis (Operational) > seed.json (Bootstrap) > Access Denied.
 *   3. SINGLE ADMIN: This service enforces a single-account model for maximum security.
 */
async function getUser(username) {
    // 优先从 Redis 读取
    if (redisClient && redisClient.isOpen) {
        try {
            const key = config.redis.userKeyPrefix + username;
            const userData = await redisClient.get(key);
            if (userData) {
                logger.info(`User "${username}" loaded from Redis`);
                return JSON.parse(userData);
            }
        } catch (err) {
            logger.error('Redis read error:', err.message);
        }
    }
    
    // Bootstrap: Dynamic seed.json (Self-destructing)
    const seedPath = path.join(__dirname, '../seed.json');
    if (fs.existsSync(seedPath)) {
        try {
            const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
            if (seed.username === username) {
                logger.info(`User "${username}" loaded from seed.json (bootstrap)`);
                return seed;
            }
        } catch (e) {
            logger.error('Failed to read seed.json:', e.message);
        }
    }

    return null;
}

const IdentityLogic = {
    /**
     * Component Lifecycle: Initialization
     */
    async init(client) {
        try {
            if (!config.redisUrl && !client) throw new Error('[Admin] FATAL: Redis URL not configured and no client provided.');

            if (client) {
                redisClient = client;
            } else if (!redisClient) {
                redisClient = createClient({
                    url: config.redisUrl
                });
                redisClient.on('error', err => logger.error('Redis Client Error', err));
                await redisClient.connect();
                logger.info('Connected to Redis');
            }

            if (!sweepInterval) {
                sweepInterval = setInterval(() => {
                    const now = Date.now();
                    for (const [key, value] of challengeStore.entries()) {
                        if (value.expiresAt < now) {
                            challengeStore.delete(key);
                        }
                    }
                }, 60000);
            }
        } catch (err) {
            logger.error('Redis initialization failed:', err);
        }
    },

    async cleanup() {
        if (sweepInterval) {
            clearInterval(sweepInterval);
            sweepInterval = null;
        }
        if (redisClient && redisClient.isOpen) {
            await redisClient.disconnect();
        }
    },

    /**
     * Phase 1 of Z-Login: Challenge Request
     */
    async loginRequest(params) {
        const { username } = params;
        const user = await getUser(username);

        const salt = user ? user.salt : crypto.randomBytes(16).toString('hex');
        const iterations = user ? user.iterations : config.defaultIterations;
        const challenge = crypto.randomBytes(16).toString('hex');
        
        challengeStore.set(challenge, {
            username: username, 
            expiresAt: Date.now() + config.challengeTtl
        });

        return { challenge, salt, iterations };
    },

    /**
     * Phase 2 of Z-Login: Challenge Verification
     */
    async loginVerify(params) {
        const { username, challenge, response } = params;
        const storedChallenge = challengeStore.get(challenge);

        if (!storedChallenge || storedChallenge.username !== username) {
            throw jsonrpc.INVALID_CHALLENGE();
        }
        
        const user = await getUser(username);
        if (!user) throw jsonrpc.AUTH_FAILED();

        const expected = crypto.createHash('sha256')
            .update(challenge + user.login_hash)
            .digest('hex');

        if (response === expected) {
            challengeStore.delete(challenge); 
            const token = crypto.randomBytes(32).toString('hex');
            
            if (redisClient && redisClient.isOpen) {
                const sessionData = {
                    username: user.username,
                    role: user.role || 'admin',
                    permit: user.permit || { allow_all: true, services: {} },
                    loginAt: new Date().toISOString(),
                    ttl: config.sessionTtl 
                };
                await redisClient.setEx(`${config.redis.sessionKeyPrefix}${token}`, config.sessionTtl, JSON.stringify(sessionData));
            }

            return { success: true, token };
        } else {
            throw jsonrpc.AUTH_FAILED();
        }
    },

    /**
     * Lock the administrator service.
     *
     * @why Enables a "just-in-time admin" pattern: when the admin is done managing,
     *      this single action (a) shortens the caller's session to 60s and (b) closes
     *      the administrator HTTP listening port. The combination eliminates both the
     *      long-lived admin token risk and the login attack surface in one step.
     * @attention
     *   1. AUTH: Verified by re-reading the session from Redis — must be an admin session.
     *   2. SLIDING REFRESH: We update both the session's `ttl` field AND the Redis EXPIRE.
     *      The field is read by Router's sliding refresh, so without updating it the
     *      TTL would just bounce back to 1800.
     *   3. RECOVERY: After lock, no RPC can restart the listener. Restarting the
     *      administrator service requires an external script (deploy/admin-up.sh).
     */
    async lockAdmin(callerToken, getServer) {
        if (!callerToken) throw jsonrpc.UNAUTHORIZED();
        if (!redisClient || !redisClient.isOpen) {
            throw new Error('Redis not available');
        }

        const sessionKey = `${config.redis.sessionKeyPrefix}${callerToken}`;
        const raw = await redisClient.get(sessionKey);
        if (!raw) throw jsonrpc.UNAUTHORIZED();

        const sess = JSON.parse(raw);
        const isAdmin = sess.permit?.allow_all === true
            || sess.permit === 'admin'
            || sess.role === 'admin';
        if (!isAdmin) throw jsonrpc.UNAUTHORIZED();

        sess.ttl = 60;
        sess.lockedAt = new Date().toISOString();
        await redisClient.set(sessionKey, JSON.stringify(sess));
        await redisClient.expire(sessionKey, 60);

        // Defer server.close() so the RPC response is delivered first.
        setTimeout(() => {
            const srv = typeof getServer === 'function' ? getServer() : null;
            if (srv && typeof srv.close === 'function') {
                logger.info('[Lock] Closing administrator HTTP server...');
                srv.close(() => logger.info('[Lock] HTTP server closed'));
            }
        }, 500);

        return { ok: true, tokenExpiresIn: 60 };
    },

    /**
     * Single Admin Persistence (Reset Password & Bootstrap Retirement)
     * 
     * @why Enforces a single-administrator model. Saves the admin to Redis 
     *      and deletes the bootstrap seed in one step.
     * @attention 
     *   1. ATOMIC LOCK: Deletes seed.json only if the username matches.
     *   2. NO MULTI-USER: This service does not support operator accounts.
     * @side_effects Writes user to Redis; deletes seed.json.
     */
    async saveAdmin(params) {
        const { username, password } = params;
        
        if (!username || !password) throw new Error('username and password required');
        if (!redisClient || !redisClient.isOpen) throw new Error('Redis connection required');

        const salt = crypto.randomBytes(16).toString('hex');
        const iterations = config.defaultIterations;
        const loginHash = crypto.pbkdf2Sync(
            password + username,
            Buffer.from(salt, 'hex'),
            iterations,
            32,
            'sha256'
        ).toString('hex');

        const userData = {
            username,
            salt,
            iterations,
            login_hash: loginHash,
            role: 'admin',
            permit: { allow_all: true },
            updatedAt: new Date().toISOString()
        };

        // 1. Write to Redis (Single User Model)
        const key = config.redis.userKeyPrefix + username;
        await redisClient.set(key, JSON.stringify(userData));

        // 2. Self-Destruct seed.json
        const seedPath = path.join(__dirname, '../seed.json');
        if (fs.existsSync(seedPath)) {
            try {
                const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
                if (seed.username === username) {
                    fs.unlinkSync(seedPath);
                    logger.info(`bootstrap-reset: seed.json deleted (${username})`);
                }
            } catch (e) {
                logger.warn('Failed to clean up seed.json:', e.message);
            }
        }

        return { success: true, username };
    }
};

module.exports = IdentityLogic;
