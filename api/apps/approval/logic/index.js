const createRecordLogic = require('./record');
const createGateLogic = require('./gate');

/**
 * Approval Logic Factory
 * @why Composes the SAP record state-machine logic + the §3.1 multi-sig gate.
 *      Dependency-injects redis + config + relay (the gate verifies signatures by
 *      relaying to user.key.getPublic).
 */
module.exports = (redis, { config, relay }) => ({
    // record gets the relay too: per-stage Ed25519 evidence is verified by relaying to
    // user.key.public (same trust path the gate uses). Without a signature it falls back
    // to server-attested, so the relay is only touched when a caller actually signs.
    record: createRecordLogic(redis, { config, relay }),
    gate:   createGateLogic(redis, { config, relay })   // §3.1 — m-of-n signature gate
});
