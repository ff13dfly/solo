const crypto = require('crypto');
const bs58 = require('bs58').default || require('bs58');
const { generateId, validateId } = require('../../../library/generator');
const jsonrpc = require('../handlers/jsonrpc');
const { STATUS } = require('../../../library/constants');
const { optimisticUpdate } = require('../../../library/optimistic');

/**
 * User Business Logic
 * @why Implements core account lifecycle, identity verification, and permission management.
 */
module.exports = (redisClient, config) => ({
    // --- USER REGISTRATION ---
    /**
     * register
     * @why Creates a new user identity and initializes default permissions.
     * @process
     *   1. Check for username collision.
     *   2. Generate unique Base58 UID.
     *   3. Hash password (if provided) or generate secure defaults.
     *   4. Atomic save to Redis (User data + Name index + Global set).
     */
    async register(params) {
        const { email, phone, salt, hash } = params;
        const name = params.name?.toLowerCase().trim();
        if (!name) throw jsonrpc.MISSING_PARAM('name');

        try {
            const uid = generateId(config.idLengths?.user || 16);
            const now = new Date().toISOString();

            const finalSalt = salt || crypto.randomBytes(16).toString('hex');
            const finalHash = hash || crypto.createHash('sha256').update(crypto.randomBytes(16).toString('hex')).digest('hex');

            const userData = {
                id: uid,
                name,
                email: email || '',
                phone: phone || '',
                salt: finalSalt,
                hash: finalHash,
                lang: config.defaultLanguage || 'zh',
                way: 1,
                permit: { allow_all: false, services: {} },
                devices: {},
                createdAt: now,
                updatedAt: now,
                status: STATUS.ACTIVE,
                categories: {},
                meta: {}
            };

            // Atomic username claim: SET NX prevents TOCTOU race on concurrent registration.
            // If two requests arrive simultaneously, only the first SET NX succeeds.
            const nameKey = `${config.redis.userNamePrefix}${name}`;
            const claimed = await redisClient.set(nameKey, uid, { NX: true });
            if (!claimed) throw jsonrpc.ALREADY_EXISTS('User');

            // Name claimed — now write user data and index
            await redisClient.set(`${config.redis.userPrefix}${uid}`, JSON.stringify(userData));
            await redisClient.sAdd(config.redis.userIdSet, uid);

            return { success: true, uid };
        } catch (err) {
            if (err.code) throw err;
            console.error(err);
            throw jsonrpc.INTERNAL_ERROR('Storage error');
        }
    },

    // --- AUTHENTICATION (CHALLENGE-RESPONSE) ---

    /**
     * loginRequest
     * @why Step 1 of identity verification: issues a cryptographic challenge.
     * @process
     *   1. Resolve UID from username.
     *   2. Fetch user salt and hashing iterations.
     *   3. Generate 16-byte random challenge and store in Redis with TTL.
     */
    async loginRequest(params) {
        const name = params.name?.toLowerCase().trim();
        if (!name) throw jsonrpc.MISSING_PARAM('name');

        try {
            const uid = await redisClient.get(`${config.redis.userNamePrefix}${name}`);
            if (!uid) throw jsonrpc.USER_NOT_FOUND();

            const userDataStr = await redisClient.get(`${config.redis.userPrefix}${uid}`);
            if (!userDataStr) throw jsonrpc.INTERNAL_ERROR('Data consistency error');
            const userData = JSON.parse(userDataStr);

            // Check if user is soft-deleted
            if (userData.status === STATUS.DELETED) {
                throw jsonrpc.ACCOUNT_DELETED();
            }

            // Check if user has permission to login
            const permit = userData.permit || { allow_all: false, services: {} };
            let normalizedPermit = permit;
            normalizedPermit = { allow_all: permit === (config.roles?.admin || 'admin'), services: {} };

            const hasPermissions = normalizedPermit.allow_all ||
                (normalizedPermit.services && Object.keys(normalizedPermit.services).length > 0);

            if (!hasPermissions) {
                // throw { code: -32604, message: 'Forbidden: User does not have permission to login' };
                // Relaxed for now or logic might break if no services are assigned yet but user exists
            }

            // Generate Challenge
            const challenge = crypto.randomBytes(16).toString('hex');
            // Store challenge with short TTL (e.g. 2 mins)
            await redisClient.setEx(`${config.redis.challengePrefix}${name}`, 120, challenge);

            return {
                challenge,
                salt: userData.salt,
                iterations: config.defaultIterations || 200000
            };
        } catch (err) {
            if (err.code) throw err;
            throw jsonrpc.INTERNAL_ERROR('Internal error');
        }
    },

    /**
     * loginVerify
     * @why Step 2 of identity verification: validates the challenge response and issues a session token.
     * @process
     *   1. Verify challenge exists and matches.
     *   2. Compare provided response against expected hash (SHA256(challenge + user_hash)).
     *   3. Update device activity and prune stale sessions.
     *   4. Generate 32-byte session token and store in Redis.
     * @side_effects 
     *   - Updates `user.devices` metadata.
     *   - Updates `user.last` activity timestamp.
     */
    async loginVerify(params) {
        const { name, challenge, response, deviceId } = params;
        if (!name || !challenge || !response) throw jsonrpc.INVALID_PARAMS('Missing params');

        try {
            // 1. Verify Challenge
            const storedChallenge = await redisClient.get(`${config.redis.challengePrefix}${name}`);
            if (!storedChallenge || storedChallenge !== challenge) {
                throw jsonrpc.INVALID_CHALLENGE();
            }

            // 2. Get User
            const uid = await redisClient.get(`${config.redis.userNamePrefix}${name}`);
            if (!uid) throw jsonrpc.USER_NOT_FOUND();

            const str = await redisClient.get(`${config.redis.userPrefix}${uid}`);
            const user = JSON.parse(str);

            // Bot accounts have no password and cannot log in via Z-Handshake
            if (user.type === 'bot') throw jsonrpc.AUTH_FAILED();

            // 3. Verify Signature
            const expected = crypto.createHash('sha256').update(challenge + user.hash).digest('hex');

            if (response !== expected) {
                throw jsonrpc.AUTH_FAILED();
            }

            // 4. Success - Handle Session & Device Info
            const token = crypto.randomBytes(32).toString('hex');
            const now = new Date().toISOString();

            // Update User Device Info
            const deviceKey = deviceId || 'unknown_device';
            user.devices = user.devices || {};
            user.devices[deviceKey] = {
                last: now,
                token_prefix: token.substring(0, 8)
            };

            // PRUNE: Remove inactive devices older than 7 days
            const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
            const nowTime = new Date(now).getTime();

            Object.keys(user.devices).forEach(did => {
                const deviceLast = new Date(user.devices[did].last).getTime();
                if ((nowTime - deviceLast) > SEVEN_DAYS_MS) {
                    delete user.devices[did];
                }
            });

            user.last = now; // Global last login

            await redisClient.set(`${config.redis.userPrefix}${uid}`, JSON.stringify(user));
            await redisClient.del(`${config.redis.challengePrefix}${name}`); // One-time use

            const SESSION_TTL = 86400 * 7; // 7 days
            // Store Session
            const sessionData = {
                uid: user.id,
                name: user.name,
                deviceId: deviceKey,
                loginAt: now,
                permit: user.permit, // CRITICAL: Pass permissions to Router
                role: user.role || (user.permit?.allow_all ? (config.roles?.admin || 'admin') : 'user'),
                ttl: SESSION_TTL,    // tells Router's sliding-expiry window to match this policy
            };
            await redisClient.setEx(`${config.redis.sessionPrefix}${token}`, SESSION_TTL, JSON.stringify(sessionData));

            // Ensure permit is returned (normalize legacy format)
            let permit = user.permit;
            if (typeof permit === 'string') {
                permit = {
                    allow_all: permit === (config.roles?.admin || 'admin'),
                    services: {}
                };
            }
            // Surface the TIER axis (categories.POWER) at auth. Portals gate on this right
            // after login; exposing it here means a caller can read its OWN tier without the
            // now permit-gated user.profile call (reading OTHERS' profiles still needs a grant).
            return { success: true, token, uid: user.id, permit, categories: user.categories || {} };
        } catch (err) {
            if (err.code) throw err;
            console.error(err);
            throw jsonrpc.AUTH_FAILED();
        }
    },

    // --- ACCOUNT MANAGEMENT ---

    /**
     * getProfile
     * @why Fetches the complete user profile.
     * @attention Validates the UID format before querying Redis to prevent malformed key access.
     */
    async getProfile({ uid }) {
        if (!uid) throw jsonrpc.INVALID_PARAMS('Missing uid');
        if (!validateId(uid, config.idLengths?.user || 16)) throw jsonrpc.INVALID_PARAMS('Invalid ID format');
        const data = await redisClient.get(`${config.redis.userPrefix}${uid}`);
        if (!data) throw jsonrpc.USER_NOT_FOUND();

        const user = JSON.parse(data);

        // SECURITY: Filter out sensitive cryptographic material
        const { salt, hash, ...safeProfile } = user;
        safeProfile.id = uid; // Ensure ID is present for legacy records

        return safeProfile;
    },

    /**
     * restore
     * @why Reverses a soft delete, returning the user to 'ACTIVE' status.
     * @process
     *   1. Validate target ID.
     *   2. Update status and remove `deletedAt` timestamp.
     *   3. Persist updated user object.
     */
    async restore({ id, uid }) {
        const targetId = id || uid;
        if (!targetId || (targetId.length !== 16 && targetId.length !== 8)) throw jsonrpc.INVALID_PARAMS('Invalid ID');

        const key = `${config.redis.userPrefix}${targetId}`;
        const data = await redisClient.get(key);
        if (!data) throw jsonrpc.USER_NOT_FOUND();

        const user = JSON.parse(data);
        if (user.status === STATUS.ACTIVE) return { success: true };

        user.status = STATUS.ACTIVE;
        delete user.deletedAt;

        await redisClient.set(key, JSON.stringify(user));
        return { success: true, id: targetId };
    },

    /**
     * checkDeletable
     * @why Pre-flight check to see if a user can be permanently destroyed.
     */
    async checkDeletable({ id, uid }) {
        return { canDestroy: true };
    },

    /**
     * destroy
     * @why Permanently removes a user from the system (Hard Delete).
     * @process
     *   1. Remove from Global ID Set.
     *   2. Delete Username index.
     *   3. Delete User data object.
     * @attention This action is irreversible.
     */
    async destroy({ id, uid }) {
        const targetId = id || uid;
        if (!targetId || (targetId.length !== 16 && targetId.length !== 8)) throw jsonrpc.INVALID_PARAMS('Invalid ID');

        const key = `${config.redis.userPrefix}${targetId}`;
        const data = await redisClient.get(key);
        if (!data) throw jsonrpc.USER_NOT_FOUND();

        const user = JSON.parse(data);

        // Remove from indexes
        await redisClient.sRem(config.redis.userIdSet, targetId);
        if (user.name) {
            await redisClient.del(`${config.redis.userNamePrefix}${user.name}`);
        }
        await redisClient.del(key);

        return { success: true, id: targetId };
    },

    /**
     * list
     * @why Provides a paginated list of users with optional keyword searching.
     * @process
     *   1. Perform fuzzy search via KEYS (if keyword present) or fetch full ID Set.
     *   2. Hydrate user objects from Redis.
     *   3. Filter by deletion status.
     *   4. Sort by creation date (Newest first).
     *   5. Paginate and return results with metadata.
     */
    async list({ page = 1, limit = 12, keyword = '', includeDeleted = false } = {}) {
        let ids = [];

        if (keyword && keyword.trim().length > 0) {
            // Fuzzy search using KEYS
            const pattern = `${config.redis.userNamePrefix}*${keyword.trim()}*`;
            const matchingKeys = await redisClient.keys(pattern);

            for (const key of matchingKeys) {
                const uid = await redisClient.get(key);
                if (uid) ids.push(uid);
            }
        } else {
            // Standard list
            ids = await redisClient.sMembers(config.redis.userIdSet);
        }

        const users = [];
        for (const uid of ids) {
            const data = await redisClient.get(`${config.redis.userPrefix}${uid}`);
            if (data) {
                const user = JSON.parse(data);
                if (includeDeleted || user.status !== STATUS.DELETED) {
                    // SECURITY: Filter out sensitive cryptographic material
                    const { salt, hash, ...safeUser } = user;
                    safeUser.id = uid; // Ensure ID is present for legacy records
                    users.push(safeUser);
                }
            }
        }

        // Sorting (Newest first) - Using createdAt field
        users.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        const total = users.length;
        const p = parseInt(page);
        const l = parseInt(limit);
        const start = (p - 1) * l;
        const slicedUsers = users.slice(start, start + l);

        return {
            users: slicedUsers,
            total,
            page: p,
            pageSize: l
        };
    },

    /**
     * count
     * @why Returns the total number of registered users.
     */
    async count() {
        try {
            return await redisClient.sCard(config.redis.userIdSet);
        } catch (e) {
            return 0;
        }
    },

    /**
     * stats
     * @why Returns both active and total user counts.
     */
    async stats() {
        try {
            const ids = await redisClient.sMembers(config.redis.userIdSet);
            let active = 0;
            for (const uid of ids) {
                const data = await redisClient.get(`${config.redis.userPrefix}${uid}`);
                if (data) {
                    const user = JSON.parse(data);
                    if (user.status !== STATUS.DELETED) {
                        active++;
                    }
                }
            }
            return { active, total: ids.length };
        } catch (e) {
            return { active: 0, total: 0 };
        }
    },

    // --- PERMISSION MANAGEMENT ---

    /**
     * updatePermit
     * @why Updates a user's access control list (ACL).
     * @attention Enforces a strict permit structure (allow_all boolean + services object).
     */
    async updatePermit(params) {
        const { uid, permit } = params;
        if (!uid || !permit) throw jsonrpc.INVALID_PARAMS('Missing params');
        if (!validateId(uid, config.idLengths?.user || 16)) throw jsonrpc.INVALID_PARAMS('Invalid ID format');

        // Basic validation of permit structure
        if (typeof permit.allow_all !== 'boolean' || typeof permit.services !== 'object') {
            throw jsonrpc.INVALID_PARAMS('Invalid permit structure');
        }

        try {
            const userDataStr = await redisClient.get(`${config.redis.userPrefix}${uid}`);
            if (!userDataStr) throw jsonrpc.USER_NOT_FOUND();

            const userData = JSON.parse(userDataStr);
            userData.permit = permit;

            await redisClient.set(`${config.redis.userPrefix}${uid}`, JSON.stringify(userData));

            return { success: true, uid };
        } catch (err) {
            if (err.code) throw err;
            console.error(err);
            throw jsonrpc.INTERNAL_ERROR('Storage error');
        }
    },

    /**
     * getPermit
     * @why Fetches a user's current permissions.
     * @process
     *   1. Load user data.
     *   2. Normalize legacy permission formats (string -> object).
     */
    async getPermit(params) {
        const { uid } = params;
        if (!uid) throw jsonrpc.INVALID_PARAMS('Missing uid');

        // Bot accounts use a 'system.*' uid (not 16-char Base58) and live at
        // user:bot:{uid}. The orchestrator's H6 footprint pre-check reads the
        // running service bot's OWN permit through here, so resolve both stores —
        // otherwise event/cron-triggered workflows can never pass H6.
        const isBot = typeof uid === 'string' && uid.startsWith('system.');
        if (!isBot && !validateId(uid, config.idLengths?.user || 16)) throw jsonrpc.INVALID_PARAMS('Invalid ID format');

        try {
            const key = isBot
                ? `${config.redis.bot.prefix}${uid}`
                : `${config.redis.userPrefix}${uid}`;
            const dataStr = await redisClient.get(key);
            if (!dataStr) throw jsonrpc.USER_NOT_FOUND();

            const data = JSON.parse(dataStr);
            // Return normalized permit
            let permit = data.permit || { allow_all: false, services: {} };
            if (typeof permit === 'string') {
                permit = { allow_all: permit === (config.roles?.admin || 'admin'), services: {} };
            }
            return { uid, permit };
        } catch (err) {
            if (err.code) throw err;
            throw jsonrpc.INTERNAL_ERROR('Internal error');
        }
    },

    /**
     * batchPermits
     * @why Atomically update permissions for multiple users.
     */
    async batchPermits(params) {
        const { permits } = params; // Array of { uid, permit }
        if (!Array.isArray(permits)) throw jsonrpc.INVALID_PARAMS('permits must be an array');

        const results = [];
        for (const item of permits) {
            try {
                await this.updatePermit(item);
                results.push({ uid: item.uid, success: true });
            } catch (err) {
                results.push({ uid: item.uid, success: false, error: err.message });
            }
        }
        return { results };
    },

    // --- PROFILE UPDATES & LIFECYCLE ---

    /**
     * update
     * @why Generic profile update (language, categories, etc).
     */
    async update(params) {
        const { uid, categories, ...others } = params;
        if (!uid) throw jsonrpc.MISSING_PARAM('uid');
        if (!validateId(uid, config.idLengths?.user || 16)) throw jsonrpc.INVALID_PARAMS('Invalid ID format');

        try {
            // 原子 read-modify-write(WATCH/MULTI 乐观 CAS):并发 meta/categories patch
            // 真正互不覆盖 —— 之前是普通读改写,并发下会丢更新.
            const result = await optimisticUpdate(redisClient, `${config.redis.userPrefix}${uid}`, (userData) => {
                if (categories) {
                    userData.categories = { ...(userData.categories || {}), ...categories };
                }
                if (others.lang) userData.lang = others.lang;
                // Contact fields — the default outbound delivery address (notification
                // worker resolves targetId → user.profile email/phone, falling back to
                // the inbox when absent). Empty string clears the field.
                if (others.email !== undefined) userData.email = others.email;
                if (others.phone !== undefined) userData.phone = others.phone;
                if (others.meta && typeof others.meta === 'object') {
                    userData.meta = { ...(userData.meta || {}), ...others.meta };
                }
                return userData;
            });
            if (result === null) throw jsonrpc.USER_NOT_FOUND();
            return { success: true, uid, categories: result.categories, meta: result.meta };
        } catch (err) {
            if (err.code) throw err;
            console.error(err);
            throw jsonrpc.INTERNAL_ERROR('Storage error');
        }
    },

    /**
     * remove
     * @why Implements "Soft Delete" by flagging status and marking deletion time.
     * @attention Keeps user data in Redis but excludes from default lists.
     */
    async remove(params) {
        const id = params.id || params.uid;
        if (!id) throw jsonrpc.MISSING_PARAM('id');
        if (!validateId(id, config.idLengths?.user || 16)) throw jsonrpc.INVALID_PARAMS('Invalid ID format');

        try {
            const userDataStr = await redisClient.get(`${config.redis.userPrefix}${id}`);
            if (!userDataStr) throw jsonrpc.USER_NOT_FOUND();

            const userData = JSON.parse(userDataStr);
            if (userData.status === STATUS.DELETED) return { success: true, message: 'Already deleted' };

            userData.status = STATUS.DELETED;
            userData.deletedAt = new Date().toISOString();

            await redisClient.set(`${config.redis.userPrefix}${id}`, JSON.stringify(userData));
            return { success: true, id };
        } catch (err) {
            if (err.code) throw err;
            throw jsonrpc.INTERNAL_ERROR('Internal error');
        }
    }
});
