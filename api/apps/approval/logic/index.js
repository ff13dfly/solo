const createRecordLogic = require('./record');
const createGateLogic = require('./gate');
const createPolicyLogic = require('./policy');

/**
 * Approval Logic Factory
 * @why Composes the SAP record state-machine logic + the §3.1 multi-sig gate + the
 *      policy tier (subject-pattern → requiredSigners/expiry defaults). Dependency-
 *      injects redis + config + relay (the gate verifies signatures by relaying to
 *      user.key.getPublic); policy is injected into both lanes so it fills whatever
 *      the caller leaves blank — explicit params always win.
 */
module.exports = (redis, { config, relay }) => {
    const policy = createPolicyLogic(redis, { config });
    return {
        // record gets the relay too: per-stage Ed25519 evidence is verified by relaying to
        // user.key.public (same trust path the gate uses). Without a signature it falls back
        // to server-attested, so the relay is only touched when a caller actually signs.
        record: createRecordLogic(redis, { config, relay, policy }),
        gate:   createGateLogic(redis, { config, relay, policy }),   // §3.1 — m-of-n signature gate
        policy,
    };
};
