/**
 * Inbound IMAP Email Polling & OTP Extraction (`gateway.imap.*`)
 *
 * Symmetric to `logic/smtp.js`:
 *   - Credentials stored via `EntityFactory` (`serviceName: 'gateway'`, `entityName: 'imap'`,
 *     `sensitiveFields: ['pass']`) with AES-256-GCM encryption at rest (`GATEWAY_SECRET_KEY`)
 *     and automatic `$owner` row-level isolation.
 *   - Enforces implicit TLS (`port: 993`, `secure: true`) by default (rejects plaintext
 *     port 143 / `secure: false` unless `GATEWAY_ALLOW_INSECURE_IMAP=1`).
 *   - Enforces SSRF protection via `library/ssrf.js` (`assertPublicHostname`) unless
 *     `GATEWAY_ALLOW_LOCAL_IMAP=1`.
 *   - Per-account Redis single-flight lock (`GATEWAY:IMAP:LOCK:<id>`) prevents concurrent
 *     polling storms on the same mailbox.
 */

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const EntityFactory = require('../../../library/entity');
const { deriveKey, encrypt, decrypt } = require('../../../library/crypto');
const jsonrpc = require('../../../library/jsonrpc');
const { isInternalOrReservedHost, assertPublicHostname } = require('../../../library/ssrf');

const SALT = 'solo-gateway-imap-v1';
const LOCK_PREFIX = 'GATEWAY:IMAP:LOCK:';
const LOCK_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 64 * 1024;
const DEFAULT_OTP_RE = /\b(\d{4,8})\b/;

let _encKey = null;

async function getEncKey() {
    if (_encKey) return _encKey;
    const secret = process.env.GATEWAY_SECRET_KEY;
    if (!secret) throw new Error('GATEWAY_SECRET_KEY is not set');
    _encKey = await deriveKey(secret, SALT);
    return _encKey;
}

function validateImapConfig(params, { isUpdate = false } = {}) {
    if (!isUpdate) {
        if (!params || typeof params.host !== 'string' || !params.host.trim()) {
            throw jsonrpc.INVALID_PARAMS("imap: 'host' is required");
        }
        if (typeof params.user !== 'string' || !params.user.trim()) {
            throw jsonrpc.INVALID_PARAMS("imap: 'user' is required");
        }
        if (typeof params.pass !== 'string' || !params.pass) {
            throw jsonrpc.INVALID_PARAMS("imap: 'pass' is required");
        }
    }
    if (params.host !== undefined) {
        if (typeof params.host !== 'string' || !params.host.trim()) {
            throw jsonrpc.INVALID_PARAMS("imap: 'host' must be a non-empty string");
        }
        if (process.env.GATEWAY_ALLOW_LOCAL_IMAP !== '1' && isInternalOrReservedHost(params.host)) {
            throw jsonrpc.INVALID_PARAMS(`imap: internal or reserved host '${params.host}' is not allowed`);
        }
    }
    const allowInsecure = process.env.GATEWAY_ALLOW_INSECURE_IMAP === '1';
    if (params.secure === false && !allowInsecure) {
        throw jsonrpc.INVALID_PARAMS('imap: secure=false (plaintext IMAP) is forbidden unless GATEWAY_ALLOW_INSECURE_IMAP=1');
    }
    if (params.port !== undefined) {
        const p = Number(params.port);
        if (!Number.isInteger(p) || p < 1 || p > 65535) {
            throw jsonrpc.INVALID_PARAMS("imap: 'port' must be a valid TCP port (1-65535)");
        }
        if (p === 143 && !allowInsecure) {
            throw jsonrpc.INVALID_PARAMS('imap: port 143 is forbidden unless GATEWAY_ALLOW_INSECURE_IMAP=1 (use port 993 with TLS)');
        }
    }
}

function createImapEntity(redis) {
    const entity = EntityFactory(redis, {
        serviceName: 'gateway',
        entityName: 'imap',
        sensitiveFields: ['pass'],
    });

    async function encryptPass(params) {
        if (!params.pass) return params;
        const key = await getEncKey();
        return { ...params, pass: encrypt(params.pass, key) };
    }

    async function decryptItem(item) {
        if (!item || !item.pass) return item;
        const key = await getEncKey();
        return { ...item, pass: decrypt(item.pass, key) };
    }

    function stripPass(item) {
        if (!item) return item;
        const { pass, ...rest } = item;
        return rest;
    }

    return {
        async create(params = {}) {
            validateImapConfig(params, { isUpdate: false });
            const normalized = {
                ...params,
                name: params.name || params.user,
                host: params.host.trim(),
                port: params.port !== undefined ? Number(params.port) : 993,
                secure: params.secure !== undefined ? Boolean(params.secure) : true,
                mailbox: params.mailbox || 'INBOX',
            };
            const data = await encryptPass(normalized);
            return stripPass(await entity.create(data));
        },
        async get({ id } = {}) {
            const item = await entity.get({ id });
            return stripPass(item);
        },
        async list(params = {}) {
            const result = await entity.list(params);
            result.items = result.items.map(stripPass);
            return result;
        },
        async update({ id, ...updates } = {}) {
            validateImapConfig(updates, { isUpdate: true });
            const data = await encryptPass(updates);
            return stripPass(await entity.update({ id, ...data }));
        },
        async delete({ id } = {}) {
            return entity.delete({ id });
        },
        async getDecrypted(id) {
            const item = await entity.get({ id });
            return decryptItem(item);
        },
    };
}

// ─── RFC 5322 / MIME / IMAP wire helpers ────────────────────────────────────

function imapQuote(str) {
    const s = String(str ?? '');
    if (/[\r\n\0]/.test(s)) {
        throw jsonrpc.INVALID_PARAMS('IMAP argument contains illegal control characters');
    }
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function decodeRfc2047(text) {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, charset, enc, body) => {
        try {
            const upper = enc.toUpperCase();
            let buf;
            if (upper === 'B') {
                buf = Buffer.from(body, 'base64');
            } else {
                const qp = body.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, hex) =>
                    String.fromCharCode(parseInt(hex, 16))
                );
                buf = Buffer.from(qp, 'binary');
            }
            return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(buf);
        } catch (_) {
            return body;
        }
    });
}

function decodeQuotedPrintable(input) {
    const cleaned = String(input || '').replace(/=\r?\n/g, '');
    const bytes = [];
    for (let i = 0; i < cleaned.length; i++) {
        if (cleaned[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
            bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
            i += 2;
        } else {
            bytes.push(cleaned.charCodeAt(i) & 0xff);
        }
    }
    return Buffer.from(bytes);
}

function splitHeadersAndBody(rawStr) {
    const match = rawStr.match(/\r?\n\r?\n/);
    if (!match) return { headerBlock: rawStr, bodyBlock: '' };
    const idx = match.index;
    const sepLen = match[0].length;
    return {
        headerBlock: rawStr.slice(0, idx),
        bodyBlock: rawStr.slice(idx + sepLen),
    };
}

function parseHeaders(headerBlock) {
    const unfolded = String(headerBlock || '').replace(/\r?\n[ \t]+/g, ' ');
    const lines = unfolded.split(/\r?\n/);
    const headers = {};
    for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        const key = line.slice(0, colon).trim().toLowerCase();
        const val = line.slice(colon + 1).trim();
        headers[key] = val;
    }
    return headers;
}

function decodePartBody(bodyBlock, transferEncoding) {
    const enc = String(transferEncoding || '').trim().toLowerCase();
    if (enc === 'base64') {
        return Buffer.from(String(bodyBlock || '').replace(/\s+/g, ''), 'base64');
    }
    if (enc === 'quoted-printable') {
        return decodeQuotedPrintable(bodyBlock);
    }
    return Buffer.from(String(bodyBlock || ''), 'utf8');
}

function stripHtmlTags(html) {
    if (!html) return '';
    return String(html)
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function parseMimeEntity(rawStr, depth = 0) {
    if (depth > 6) return { textBody: '', htmlBody: '', attachments: [] };
    const { headerBlock, bodyBlock } = splitHeadersAndBody(rawStr);
    const headers = parseHeaders(headerBlock);
    const ctFull = headers['content-type'] || 'text/plain; charset=utf-8';
    const ctMime = ctFull.split(';')[0].trim().toLowerCase();
    const disp = headers['content-disposition'] || '';
    const cte = headers['content-transfer-encoding'] || '';

    const boundaryMatch = ctFull.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
    if (ctMime.startsWith('multipart/') && boundaryMatch) {
        const boundary = boundaryMatch[1] || boundaryMatch[2];
        const delim = `--${boundary}`;
        const parts = bodyBlock.split(delim).slice(1);
        let textBody = '';
        let htmlBody = '';
        const attachments = [];
        for (const part of parts) {
            if (part.startsWith('--')) break;
            const trimmedPart = part.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
            if (!trimmedPart) continue;
            const sub = parseMimeEntity(trimmedPart, depth + 1);
            if (sub.textBody && !textBody) textBody = sub.textBody;
            if (sub.htmlBody && !htmlBody) htmlBody = sub.htmlBody;
            if (sub.attachments.length) attachments.push(...sub.attachments);
        }
        return { headers, textBody, htmlBody, attachments };
    }

    const filenameMatch = disp.match(/filename\*?=(?:"([^"]+)"|([^;\s]+))/i) || ctFull.match(/name=(?:"([^"]+)"|([^;\s]+))/i);
    const isAttachment = /^attachment/i.test(disp.trim()) || Boolean(filenameMatch && !ctMime.startsWith('text/'));
    const decodedBuf = decodePartBody(bodyBlock, cte);

    if (isAttachment) {
        const rawFilename = filenameMatch ? (filenameMatch[1] || filenameMatch[2]) : 'attachment.bin';
        return {
            headers,
            textBody: '',
            htmlBody: '',
            attachments: [{
                filename: decodeRfc2047(rawFilename),
                mimeType: ctMime || 'application/octet-stream',
                size: decodedBuf.length,
                content: decodedBuf,
            }],
        };
    }

    const charsetMatch = ctFull.match(/charset=(?:"([^"]+)"|([^;\s]+))/i);
    const charset = (charsetMatch ? (charsetMatch[1] || charsetMatch[2]) : 'utf-8').toLowerCase();
    let text;
    try {
        text = new TextDecoder(charset, { fatal: false }).decode(decodedBuf);
    } catch (_) {
        text = decodedBuf.toString('utf8');
    }

    if (ctMime === 'text/html') {
        return { headers, textBody: '', htmlBody: text, attachments: [] };
    }
    return { headers, textBody: text, htmlBody: '', attachments: [] };
}

function parseRawEmail(rawEmailStr) {
    const parsed = parseMimeEntity(rawEmailStr);
    const headers = parsed.headers || {};
    const subject = decodeRfc2047(headers['subject'] || '');
    const from = decodeRfc2047(headers['from'] || '');
    const to = decodeRfc2047(headers['to'] || '');
    const messageId = headers['message-id'] || null;
    const dateStr = headers['date'] || null;
    const dateMs = dateStr ? new Date(dateStr).getTime() : null;
    const textBody = parsed.textBody || stripHtmlTags(parsed.htmlBody || '');
    const htmlBody = parsed.htmlBody || '';
    return {
        messageId,
        from,
        to,
        subject,
        date: Number.isFinite(dateMs) ? new Date(dateMs).toISOString() : null,
        dateMs: Number.isFinite(dateMs) ? dateMs : null,
        textBody,
        htmlBody,
        attachments: parsed.attachments || [],
    };
}

function extractOtpFromText(subject, textBody, extractOtpOpt) {
    if (!extractOtpOpt) return null;
    const combined = `${subject || ''}\n${textBody || ''}`.slice(0, 16384);
    let re = DEFAULT_OTP_RE;
    if (typeof extractOtpOpt === 'string' && extractOtpOpt.trim()) {
        if (extractOtpOpt.length > 128) {
            throw jsonrpc.INVALID_PARAMS('extractOtp regex pattern must be <= 128 chars');
        }
        try {
            re = new RegExp(extractOtpOpt);
        } catch (e) {
            throw jsonrpc.INVALID_PARAMS(`Invalid extractOtp regex: ${e.message}`);
        }
    }
    const m = combined.match(re);
    if (!m) return null;
    return m[1] !== undefined ? m[1] : m[0];
}

function formatImapDate(ms) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const d = new Date(ms);
    return `${d.getUTCDate()}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

// ─── Lightweight IMAP4rev1 Socket Session ───────────────────────────────────

async function createImapSession(cfg) {
    const allowLocal = process.env.GATEWAY_ALLOW_LOCAL_IMAP === '1';
    await assertPublicHostname(cfg.host, { allowLoopback: allowLocal });

    const port = Number(cfg.port) || 993;
    const secure = cfg.secure !== false;
    const timeoutMs = Number(cfg.options?.timeoutMs) || DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
        let socket;
        let buffer = '';
        let pending = null;
        let tagCounter = 0;
        let greetingReceived = false;

        const cleanup = () => {
            if (socket && !socket.destroyed) socket.destroy();
        };

        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`IMAP connection timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        const tryFlush = () => {
            if (!greetingReceived) {
                const idx = buffer.indexOf('\r\n');
                if (idx !== -1) {
                    const line = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    greetingReceived = true;
                    if (!/^\*\s+(OK|PREAUTH)/i.test(line)) {
                        clearTimeout(timer);
                        cleanup();
                        return reject(new Error(`Unexpected IMAP greeting: ${line}`));
                    }
                    clearTimeout(timer);
                    resolve(api);
                }
                return;
            }
            if (!pending) return;
            const { tag, resolveCmd, rejectCmd, cmdTimer } = pending;
            const tagRegex = new RegExp(`(?:^|\\r\\n)${tag}\\s+(OK|NO|BAD)\\b([^\\r\\n]*)\\r\\n`, 'i');
            const m = buffer.match(tagRegex);
            if (!m) return;
            const endIdx = m.index + m[0].length;
            const rawResponse = buffer.slice(0, endIdx);
            buffer = buffer.slice(endIdx);
            clearTimeout(cmdTimer);
            pending = null;
            const status = m[1].toUpperCase();
            if (status !== 'OK') {
                rejectCmd(new Error(`IMAP ${tag} ${status}:${m[2] || ''}`));
            } else {
                resolveCmd(rawResponse);
            }
        };

        const api = {
            command(cmdLine) {
                return new Promise((resolveCmd, rejectCmd) => {
                    const tag = `A${++tagCounter}`;
                    const cmdTimer = setTimeout(() => {
                        pending = null;
                        cleanup();
                        rejectCmd(new Error(`IMAP command ${tag} timed out`));
                    }, timeoutMs);
                    pending = { tag, resolveCmd, rejectCmd, cmdTimer };
                    socket.write(`${tag} ${cmdLine}\r\n`);
                });
            },
            close() {
                cleanup();
            },
        };

        const onError = (err) => {
            clearTimeout(timer);
            if (pending) {
                clearTimeout(pending.cmdTimer);
                const { rejectCmd } = pending;
                pending = null;
                rejectCmd(err);
            } else {
                reject(err);
            }
        };

        if (secure) {
            socket = tls.connect({
                host: cfg.host,
                port,
                servername: cfg.host,
                rejectUnauthorized: cfg.options?.tls?.rejectUnauthorized !== false,
            });
        } else {
            socket = net.connect({ host: cfg.host, port });
        }

        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
            buffer += chunk;
            tryFlush();
        });
        socket.on('error', onError);
        socket.on('close', () => {
            if (!greetingReceived) {
                clearTimeout(timer);
                reject(new Error('IMAP socket closed before greeting'));
            } else if (pending) {
                clearTimeout(pending.cmdTimer);
                const { rejectCmd } = pending;
                pending = null;
                rejectCmd(new Error('IMAP socket closed unexpectedly'));
            }
        });
    });
}

function extractLiteralFromFetch(fetchResp) {
    const litMatch = fetchResp.match(/BODY(?:\[\]|\[\d*\])\s*\{(\d+)\}\r\n/i) || fetchResp.match(/\{(\d+)\}\r\n/);
    if (litMatch) {
        const start = litMatch.index + litMatch[0].length;
        const byteLen = parseInt(litMatch[1], 10);
        const tailBuf = Buffer.from(fetchResp.slice(start), 'utf8');
        return tailBuf.subarray(0, byteLen).toString('utf8');
    }
    const firstCrlf = fetchResp.indexOf('\r\n');
    const lastParen = fetchResp.lastIndexOf(')\r\n');
    if (firstCrlf !== -1 && lastParen > firstCrlf) {
        return fetchResp.slice(firstCrlf + 2, lastParen);
    }
    return fetchResp;
}

function buildImapIdCommand(clientId) {
    if (clientId === false) return null;
    const base = {
        name: 'SOLO-Gateway',
        version: '1.0.0',
        vendor: 'SOLO',
    };
    const merged = (clientId && typeof clientId === 'object' && !Array.isArray(clientId))
        ? { ...base, ...clientId }
        : (typeof clientId === 'string' && clientId.trim() ? { ...base, name: clientId.trim() } : base);
    const pairs = [];
    for (const [k, v] of Object.entries(merged)) {
        if (v === undefined || v === null || v === '') continue;
        pairs.push(`${imapQuote(k)} ${imapQuote(String(v))}`);
    }
    return pairs.length ? `ID (${pairs.join(' ')})` : null;
}

async function testImapConnection(cfg, opts = {}) {
    validateImapConfig(cfg, { isUpdate: false });
    const sessionFactory = opts.sessionFactory || createImapSession;
    const session = await sessionFactory(cfg);
    try {
        await session.command(`LOGIN ${imapQuote(cfg.user)} ${imapQuote(cfg.pass)}`);
        // RFC 2971 ID extension required by NetEase (163.com / 126.com / yeah.net / qiye.163.com)
        // before SELECT/EXAMINE to avoid "NO SELECT Unsafe Login"; ignored if server returns BAD/NO.
        const idCmd = buildImapIdCommand(opts.clientId ?? cfg.clientId ?? cfg.options?.clientId);
        if (idCmd) {
            await session.command(idCmd).catch(() => {});
        }
        const mailbox = cfg.mailbox || 'INBOX';
        await session.command(`EXAMINE ${imapQuote(mailbox)}`);
        await session.command('LOGOUT').catch(() => {});
        return { success: true, message: 'IMAP connection verified', mailbox };
    } finally {
        session.close();
    }
}

async function withImapLock(redis, imapId, fn) {
    const lockKey = `${LOCK_PREFIX}${imapId}`;
    const token = crypto.randomBytes(8).toString('hex');
    const acquired = await redis.set(lockKey, token, { NX: true, PX: LOCK_TTL_MS });
    if (!acquired) {
        throw jsonrpc.INVALID_PARAMS(`IMAP poll already in progress for account ${imapId}`);
    }
    try {
        return await fn();
    } finally {
        try {
            if ((await redis.get(lockKey)) === token) {
                await redis.del(lockKey);
            }
        } catch (_) { /* ignore */ }
    }
}

async function pollImapAccount({ redis, imapEntity, relay = null, sessionFactory = createImapSession }, params = {}) {
    const {
        imapId,
        mailbox: reqMailbox,
        sinceMs,
        fromContains,
        subjectContains,
        unseenOnly = false,
        markSeen = false,
        limit = 10,
        extractOtp = false,
        includeBody = false,
        saveAttachmentsToStorage = false,
        clientId,
    } = params;

    if (!imapId) throw jsonrpc.MISSING_PARAM('imapId');
    const cfg = await imapEntity.getDecrypted(imapId);
    validateImapConfig(cfg, { isUpdate: false });
    const mailbox = reqMailbox || cfg.mailbox || 'INBOX';
    const maxItems = Math.max(1, Math.min(Number(limit) || 10, 50));

    return withImapLock(redis, imapId, async () => {
        const session = await sessionFactory(cfg);
        try {
            await session.command(`LOGIN ${imapQuote(cfg.user)} ${imapQuote(cfg.pass)}`);
            const idCmd = buildImapIdCommand(clientId ?? cfg.clientId ?? cfg.options?.clientId);
            if (idCmd) {
                await session.command(idCmd).catch(() => {});
            }
            await session.command(`${markSeen ? 'SELECT' : 'EXAMINE'} ${imapQuote(mailbox)}`);

            const criteria = [];
            if (unseenOnly) criteria.push('UNSEEN');
            if (Number.isFinite(sinceMs) && sinceMs > 0) {
                criteria.push(`SINCE ${formatImapDate(sinceMs)}`);
            }
            if (!criteria.length) criteria.push('ALL');

            const searchResp = await session.command(`UID SEARCH ${criteria.join(' ')}`);
            const searchLine = searchResp
                .split('\r\n')
                .find((l) => /^\*\s+SEARCH\b/i.test(l)) || '';
            const allUids = searchLine
                .replace(/^\*\s+SEARCH\s*/i, '')
                .trim()
                .split(/\s+/)
                .filter((u) => /^\d+$/.test(u));

            // Newest UIDs first
            const candidateUids = allUids.slice(-maxItems * 3).reverse();
            const items = [];

            for (const uid of candidateUids) {
                if (items.length >= maxItems) break;
                const fetchCmd = markSeen
                    ? `UID FETCH ${uid} (UID FLAGS BODY[])`
                    : `UID FETCH ${uid} (UID FLAGS BODY.PEEK[])`;
                const fetchResp = await session.command(fetchCmd);
                const rawEmail = extractLiteralFromFetch(fetchResp);
                const parsed = parseRawEmail(rawEmail);

                if (Number.isFinite(sinceMs) && parsed.dateMs && parsed.dateMs < sinceMs) {
                    continue;
                }
                if (fromContains && !parsed.from.toLowerCase().includes(String(fromContains).toLowerCase())) {
                    continue;
                }
                if (subjectContains && !parsed.subject.toLowerCase().includes(String(subjectContains).toLowerCase())) {
                    continue;
                }

                const otp = extractOtp ? extractOtpFromText(parsed.subject, parsed.textBody, extractOtp) : null;

                const outAttachments = [];
                for (const att of parsed.attachments) {
                    if (saveAttachmentsToStorage && relay) {
                        const uploaded = await relay.call('storage.asset.upload', {
                            file: att.content.toString('base64'),
                            filename: att.filename,
                            mimeType: att.mimeType,
                            visibility: 'private',
                            ttlSec: 86400,
                        });
                        outAttachments.push({
                            filename: att.filename,
                            mimeType: att.mimeType,
                            size: att.size,
                            assetId: uploaded && uploaded.id ? uploaded.id : null,
                        });
                    } else {
                        outAttachments.push({
                            filename: att.filename,
                            mimeType: att.mimeType,
                            size: att.size,
                        });
                    }
                }

                const entry = {
                    uid: String(uid),
                    messageId: parsed.messageId,
                    from: parsed.from,
                    to: parsed.to,
                    subject: parsed.subject,
                    date: parsed.date,
                    otp,
                    textSnippet: (parsed.textBody || '').slice(0, 500),
                    ...(includeBody ? {
                        textBody: (parsed.textBody || '').slice(0, MAX_BODY_CHARS),
                        htmlBody: (parsed.htmlBody || '').slice(0, MAX_BODY_CHARS),
                    } : {}),
                    attachments: outAttachments,
                };
                items.push(entry);
            }

            await session.command('LOGOUT').catch(() => {});
            return { items, total: items.length, mailbox };
        } finally {
            session.close();
        }
    });
}

module.exports = {
    createImapEntity,
    testImapConnection,
    pollImapAccount,
    parseRawEmail,
    extractOtpFromText,
    buildImapIdCommand,
};
