/**
 * Aliyun API-gateway V3 request signing — `ACS3-HMAC-SHA256`.
 *
 * @why  The previous SMS code sent `Authorization: AccessKeyId <id>` with a JSON body,
 *       which Aliyun has never accepted (it is not a signing scheme at all) — every
 *       send 4xx'd, and because resolveChannel() picks aliyun the moment a key id is
 *       present, configuring real credentials was WORSE than leaving them unset
 *       (no mock fallback). See docs/planning/gateway-gaps.md G1.
 *
 * @scope RPC-style APIs called with parameters in the QUERY STRING and an empty body
 *        (that is how SendSms is invoked here). Signing an API with a JSON body works
 *        too — pass `body` and the payload hash follows it.
 *
 * Algorithm (Aliyun "V3 签名" / ACS3-HMAC-SHA256):
 *
 *   canonicalRequest = METHOD \n CanonicalURI \n CanonicalQueryString \n
 *                      CanonicalHeaders \n SignedHeaders \n HashedRequestPayload
 *   stringToSign     = "ACS3-HMAC-SHA256" \n hex(sha256(canonicalRequest))
 *   signature        = hex(hmacSha256(accessKeySecret, stringToSign))
 *   Authorization    = ACS3-HMAC-SHA256 Credential=<id>,SignedHeaders=<h>,Signature=<sig>
 *
 * CanonicalHeaders signs `host` + every `x-acs-*` header (+ content-type when present),
 * each as `lowercased-name:trimmed-value\n`, sorted by name; SignedHeaders is the same
 * names joined by ';'.
 *
 * @attention `date` and `nonce` are INJECTABLE so the signature is deterministic under
 *            test (clock.now() is the production default via logic/sms.js).
 */
const crypto = require('crypto');

const ALGORITHM = 'ACS3-HMAC-SHA256';

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmacHex = (key, data) => crypto.createHmac('sha256', key).update(data).digest('hex');

/**
 * RFC 3986 percent-encoding. encodeURIComponent leaves !'()* unescaped and already
 * leaves the unreserved set (A-Za-z0-9-_.~) alone, so only those five need fixing.
 */
function percentEncode(str) {
    return encodeURIComponent(String(str))
        .replace(/!/g, '%21')
        .replace(/'/g, '%27')
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29')
        .replace(/\*/g, '%2A');
}

/** Sorted `k=v` pairs, both percent-encoded. Undefined/null values are dropped. */
function canonicalQueryString(query = {}) {
    return Object.keys(query)
        .filter((k) => query[k] !== undefined && query[k] !== null)
        .sort()
        .map((k) => `${percentEncode(k)}=${percentEncode(query[k])}`)
        .join('&');
}

/**
 * Build the signed headers + Authorization for one request.
 *
 * @param {object}  opts
 * @param {string}  opts.accessKeyId
 * @param {string}  opts.accessKeySecret
 * @param {string}  opts.host          e.g. 'dysmsapi.aliyuncs.com'
 * @param {string}  opts.action        e.g. 'SendSms'
 * @param {string}  opts.version       API version, e.g. '2017-05-25'
 * @param {object}  [opts.query]       RPC parameters (query string)
 * @param {string}  [opts.body]        request body ('' for RPC-in-query calls)
 * @param {string}  [opts.method]      default 'POST'
 * @param {string}  [opts.canonicalUri] default '/'
 * @param {Date|number|string} [opts.date]  signing moment (default: real now)
 * @param {string}  [opts.nonce]       signature nonce (default: random)
 * @returns {{ headers: object, signature: string, stringToSign: string, canonicalRequest: string, query: string }}
 */
function signRequest(opts) {
    const {
        accessKeyId, accessKeySecret, host, action, version,
        query = {}, body = '', method = 'POST', canonicalUri = '/',
        date, nonce,
    } = opts;

    if (!accessKeyId || !accessKeySecret) {
        throw new Error('aliyun-sign: accessKeyId and accessKeySecret are required');
    }

    // x-acs-date is ISO 8601 UTC with second precision, no milliseconds.
    const iso = new Date(date === undefined ? Date.now() : date).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const payloadHash = sha256Hex(body || '');

    const signed = {
        host,
        'x-acs-action': action,
        'x-acs-content-sha256': payloadHash,
        'x-acs-date': iso,
        'x-acs-signature-nonce': nonce || crypto.randomBytes(16).toString('hex'),
        'x-acs-version': version,
    };

    const names = Object.keys(signed).sort();
    const canonicalHeaders = names.map((n) => `${n}:${String(signed[n]).trim()}\n`).join('');
    const signedHeaders = names.join(';');
    const qs = canonicalQueryString(query);

    const canonicalRequest = [
        method, canonicalUri, qs, canonicalHeaders, signedHeaders, payloadHash,
    ].join('\n');

    const stringToSign = `${ALGORITHM}\n${sha256Hex(canonicalRequest)}`;
    const signature = hmacHex(accessKeySecret, stringToSign);

    return {
        headers: {
            ...signed,
            Authorization: `${ALGORITHM} Credential=${accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`,
        },
        signature,
        stringToSign,
        canonicalRequest,
        query: qs,
    };
}

module.exports = { signRequest, percentEncode, canonicalQueryString, sha256Hex, ALGORITHM };
