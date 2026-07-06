/**
 * Runtime automation control (the auto↔manual seam).
 *
 * @why SOLO is meant to run automatically (matcher → workflow runs, scheduler) OR
 *      fully manually. The boot-time ORCH_WORKER/ORCH_MATCHER env switches can't be
 *      flipped live. This is the RUNTIME pause: an admin pauses → the automation loops
 *      (worker, matcher) stop draining/consuming, but every RPC handler keeps working,
 *      so the system degrades to manual with no restart. Resume to go back to auto.
 *
 *   ORCHESTRATOR:CONTROL:PAUSED   '1' = paused (absent = running)
 */
const config = require('../config');

module.exports = (redis) => {
    const key = config.redis.controlPausedKey;
    async function isPaused() { return (await redis.get(key)) === '1'; }
    return {
        isPaused,
        async pause()  { await redis.set(key, '1'); return { paused: true }; },
        async resume() { await redis.del(key);      return { paused: false }; },
        async status() { return { paused: await isPaused() }; },
    };
};
