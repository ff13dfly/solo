/**
 * Runtime automation control (the auto↔manual seam).
 *
 * @why nexus runs automatically (stream consumer delivers events to Sentinels; the
 *      scheduler fires due tasks) OR can be paused to manual. The boot-time
 *      NEXUS_CONSUMER/NEXUS_SCHEDULER env switches can't be flipped live. This is the
 *      RUNTIME pause: an admin pauses → the consumer + scheduler loops stop, but every
 *      RPC handler (sentinel/schedule/dlq CRUD) keeps working — degrade to manual with
 *      no restart. Resume to go back to auto.
 *
 *   NEXUS:CONTROL:PAUSED   '1' = paused (absent = running)
 */
module.exports = (redis, config) => {
    const key = config.redis.controlPausedKey;
    async function isPaused() { return (await redis.get(key)) === '1'; }
    return {
        isPaused,
        async pause()  { await redis.set(key, '1'); return { paused: true }; },
        async resume() { await redis.del(key);      return { paused: false }; },
        async status() { return { paused: await isPaused() }; },
    };
};
