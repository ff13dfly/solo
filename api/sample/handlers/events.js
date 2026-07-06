/**
 * Event surface area — emitted and subscribed streams.
 * Exposed via the `events` RPC method; aggregated by the Router's capability map.
 *
 * emits:      events this service publishes to the event bus (via relay or _event piggyback)
 * subscribes: event streams this service internally consumes
 *             (for most services this is empty — consumption is handled by nexus sentinels)
 */
module.exports = {
    emits: [
        // {
        //     stream:      'EVENT:SAMPLE:SOMETHING_HAPPENED',
        //     type:        'something.happened',
        //     trigger:     'sample.entity.action',
        //     description: 'Emitted when an entity action completes',
        //     payload: {
        //         id:     'string',
        //         status: 'string',
        //         stamp:  'number',
        //     },
        // },
    ],
    subscribes: [],
};
