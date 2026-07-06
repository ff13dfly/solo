/**
 * System API Registry (The System Contract)
 * 
 * @why This file defines the "Static Infrastructure" of the entire OS. 
 *      It serves as the definitive source of truth for:
 *      1. SECURITY: Hardcoded public/private status for core gates.
 *      2. STUBS: Maintaining "Reserved Seats" for essential services (like agent.chat)
 *         even if the underlying microservice is temporarily offline.
 *      3. INTROSPECTION: Providing the base skeleton for the global Capability Map.
 */
module.exports = {
    // Basic Infrastructure
    'ping': { internal: true, public: true, desc: 'Health check' },
    'methods': { internal: true, public: true, desc: 'List available methods' },

    // Service Management
    'system.service.status': { internal: true, public: true, desc: 'Check service health' },
    'system.service.list': { internal: true, public: true, desc: 'List all registered services' },
    'system.service.add': { internal: true, public: false, desc: 'Register new service' },
    'system.service.remove': { internal: true, public: false, desc: 'Remove service' },

    // Capability Discovery
    'system.capability.list': { internal: true, public: true, desc: 'Return capability map' },

    // Logging & Monitoring (Router Specific)
    'system.log.interaction': { internal: true, public: false, desc: 'Retrieve analyzed user logs' },
    'admin.log.debug': { internal: true, public: false, desc: 'Read router debug logs' },
    'admin.log.interaction': { internal: true, public: false, desc: 'Retrieve analyzed interaction logs' },
    'admin.log.clear': { internal: true, public: false, desc: 'Clear router debug logs' },

    // Workflow & Agent
    'system.workflow.list': { internal: true, public: false, desc: 'List published workflows' },
    'agent.chat': { internal: false, public: false, desc: 'AI agent chat interaction (auth required; anon/guest flows go through a bot account)' },

    // Federated Categories
    'system.category.reserve': { internal: true, public: false, desc: 'Atomic reservation of category key' },
    'system.category.delete': { internal: true, public: false, desc: 'Soft delete category' },
    'system.category.locate': { internal: true, public: false, desc: 'Find owner service for a key' },
    'system.category.list': { internal: true, public: false, desc: 'List all registered categories' },

    // Other Global Public Gates
    // Narrowed 2026-06-30 (spec-passport-self-issuance.md §7): no longer anonymously reachable —
    // callers now need a session (passport self-issuance gives every external user one).
    'storage.asset.multi': { internal: false, public: false, desc: 'Batch resolve asset URLs (auth required)' },
};
