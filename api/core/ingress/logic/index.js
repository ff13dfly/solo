const createSource = require('./source');
const createDedup = require('./dedup');
const createAudit = require('./audit');
const createReview = require('./review');
const createIngest = require('./ingest');

/**
 * Logic Factory — dependency injection (Redis, config, relay).
 *
 * relay is required for event.emit (security.md §7.7 — internal cross-service
 * calls go through the shared relay bot, never raw HTTP).
 */
module.exports = (redis, { config, relay }) => {
    const source = createSource(redis, { config });
    const dedup = createDedup(redis, { config });
    const audit = createAudit();
    const review = createReview(redis, { config, relay, source });
    const ingest = createIngest(redis, { config, relay, source, dedup, audit, review });

    return { source, dedup, audit, review, ingest };
};
