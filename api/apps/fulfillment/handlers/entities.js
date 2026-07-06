const { STATUS } = require('../../../library/constants');

/**
 * Entity Schema Definitions
 * @why Consumed by the Router and Portal to understand data shapes,
 *      drive generic UI rendering, and enable AI entity extraction.
 */

module.exports = {
    'instance': {
        description: 'A fulfillment lifecycle record tracking an order from creation to close',
        softDelete: false,
        fields: {
            'id':             { type: 'string',   description: 'Instance ID (e.g. FL-20260312-001)', required: true },
            'sourceId':       { type: 'string',   description: 'Source order ID', required: true },
            'profileId':      { type: 'string',   description: 'Applied fulfillment profile ID', required: true },
            'state': {
                type: 'string',
                required: true,
                description: 'Current lifecycle state. States are defined per Profile — any uppercase string is valid. System-reserved: DRAFT (initial state on create), CANCELLED (conventional terminal state).'
            },
            'prevState':      { type: 'string',   description: 'Previous state before last transition' },
            'stateChangedAt': { type: 'datetime', description: 'Timestamp of last state change' },
            'createdAt':      { type: 'datetime', description: 'Creation timestamp' },
            'createdBy':      { type: 'string',   description: 'User who created the instance' },
            'meta':           { type: 'object',   description: 'Free-form metadata updated per transition' },
            'history':        { type: 'array',    description: 'Ordered log of state transitions' }
        }
    },

    'profile': {
        description: 'State machine configuration template applied to fulfillment instances',
        softDelete: true,
        fields: {
            'id':          { type: 'string',   description: 'Profile unique key (e.g. standard_trade)', required: true },
            'name':        { type: 'string',   description: 'Human-readable profile name', required: true },
            'transitions': { type: 'array',    description: 'Transition rules (JsonLogic conditions + actions)' },
            'status':      { type: 'enum',     options: [STATUS.ACTIVE, STATUS.DELETED], description: 'Entity lifecycle status (soft-delete axis)' },
            'reviewState': { type: 'enum',     options: ['PENDING_REVIEW', 'APPROVED', 'REJECTED'], description: 'Governance review axis (submission lane). ABSENT for trusted direct-create profiles (immediately usable); set by profile.submit/approve/reject. Instances may only be created on an absent-or-APPROVED profile.' },
            'submittedBy': { type: 'string',   description: 'UID that submitted the profile for review (null for direct-create)' },
            'approvedDigest': { type: 'string', description: 'sha256 of the canonical executable definition (transitions + meta_fields) at approval time — binds the approval to the exact version. Cleared when executable fields are edited (which re-opens review).' },
            'createdAt':   { type: 'datetime', description: 'Creation timestamp' },
            'updatedAt':   { type: 'datetime', description: 'Last update timestamp' }
        }
    }
};
