/**
 * Shared parameter-string validation primitives.
 *
 * Single source of truth for "is this string acceptable". Used by BOTH:
 *   - the Router's perimeter validator (router/handlers/validator.js), and
 *   - any microservice that wants to self-validate semantic input in its logic layer.
 *
 * Design:
 *   - Pure functions, no I/O, no deps — safe to require anywhere, incl. the hot path.
 *   - Never throws on bad input: helpers tolerate non-strings (callers decide when to call).
 *   - Patterns are a NAMED registry so introspection schemas declare `pattern: 'id'`
 *     (a stable, shared vocabulary) instead of inlining a regex per service.
 *
 * Declare in the schema, enforce at the Router, implement here.
 */

// C0 control chars EXCEPT tab(\t=09)/newline(\n=0A)/carriage-return(\r=0D), plus DEL(7F).
// No legitimate API string field needs a NUL or other control byte; rejecting them closes
// stored-injection / log-injection / index-pollution vectors. \t \n \r stay legal so genuine
// free-text fields (desc/body/markdown) are unaffected. Built via new RegExp(escaped-string)
// so the source stays clean ASCII (no literal control bytes).
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]');

// Named pattern vocabulary. Deliberately small + permissive — reject the obviously-malformed,
// not legitimate human input.
const PATTERNS = {
    // identifier-ish: ids, uids, foreign keys, category keys. Base58 ids (library/generator.js)
    // are a strict subset of this, so real ids never false-trip.
    id:       /^[A-Za-z0-9_-]{1,64}$/,
    uid:      /^[A-Za-z0-9_-]{1,64}$/,
    // url/category slugs: lowercase, digit, hyphen
    slug:     /^[a-z0-9][a-z0-9-]{0,63}$/,
    // a display name: letters/digits/space/dot/underscore/hyphen/CJK(U+4E00-U+9FA5).
    // Permissive on charset (names are human) — real safety comes from length + control floor.
    username: new RegExp('^[\\w .\\u4e00-\\u9fa5-]{1,64}$', 'u'),
    email:    /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,24}$/,
    phone:    /^\+?[0-9][0-9 \-]{4,19}$/,
};

/** True if s is a string containing a forbidden control character. */
function hasControlChars(s) {
    return typeof s === 'string' && CONTROL_CHARS.test(s);
}

/** True if s is not a string, or is empty/whitespace-only. */
function isBlank(s) {
    return typeof s !== 'string' || s.trim().length === 0;
}

/** NFC-normalize + trim. Returns the input unchanged if it is not a string. */
function normalizeString(s) {
    if (typeof s !== 'string') return s;
    return s.normalize('NFC').trim();
}

/**
 * Validate one string value against a rule. Returns an error MESSAGE (string) or null.
 * Only meaningful for string values — returns null for non-strings (type enforced elsewhere).
 *
 * rule: { name?, required?, maxLength?, minLength?, pattern? }
 */
function checkString(value, rule = {}) {
    const label = rule.name || 'value';
    if (typeof value !== 'string') return null;
    if (hasControlChars(value)) return `'${label}' contains control characters`;
    if (rule.required && value.trim().length === 0) return `'${label}' must not be blank`;
    if (rule.maxLength && value.length > rule.maxLength) return `'${label}' exceeds maximum length of ${rule.maxLength}`;
    if (rule.minLength && value.length < rule.minLength) return `'${label}' is shorter than minimum length of ${rule.minLength}`;
    if (rule.pattern) {
        const re = PATTERNS[rule.pattern];
        if (re && !re.test(value)) return `'${label}' has invalid format (expected ${rule.pattern})`;
    }
    return null;
}

/**
 * Validate a params object against a flat schema (array of rule items).
 * Same dialect the Router perimeter validator speaks — services declare
 * the SAME item shape in workflow `input_schema` / step `result_schema`
 * (toFix §6.3), so one vocabulary covers both perimeters.
 *
 * items: [{ name, required?, type?, pattern?, minLength?, maxLength? }]
 *   - type: 'string' | 'number' | 'boolean' | 'object' | 'array'
 *   - string rules (pattern/minLength/maxLength/control-floor) via checkString.
 *
 * Returns an array of error messages — empty means valid. Never throws.
 * Unknown keys in params are NOT rejected (additive payloads stay legal);
 * the schema constrains what the workflow consumes, not what callers send.
 */
function checkParams(items, params) {
    const errors = [];
    if (!Array.isArray(items)) return errors;
    const source = (params && typeof params === 'object') ? params : {};
    for (const item of items) {
        if (!item || typeof item.name !== 'string' || !item.name) continue;
        const value = source[item.name];
        if (value === undefined || value === null) {
            if (item.required) errors.push(`'${item.name}' is required`);
            continue;
        }
        if (item.type) {
            const actual = Array.isArray(value) ? 'array' : typeof value;
            if (actual !== item.type) {
                errors.push(`'${item.name}' must be ${item.type} (got ${actual})`);
                continue;
            }
        }
        if (typeof value === 'string') {
            const msg = checkString(value, item);
            if (msg) errors.push(msg);
        }
    }
    return errors;
}

module.exports = { PATTERNS, CONTROL_CHARS, hasControlChars, isBlank, normalizeString, checkString, checkParams };
