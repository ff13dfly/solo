/**
 * Sample Business Logic
 * @why Implements the core functional requirements for the "sample" feature area.
 */
module.exports = (redis) => ({

    async ping() {
        return { pong: true };
    }
});
