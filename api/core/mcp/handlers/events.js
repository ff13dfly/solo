/**
 * Event surface area — this service neither emits nor subscribes to events.
 * It is a synchronous request/response protocol adapter (MCP tools/call ->
 * orchestrator.workflow.run via Router), not an event-bus participant.
 */
module.exports = {
    emits: [],
    subscribes: [],
};
