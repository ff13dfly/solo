/**
 * Entity Discovery handler
 * @why Required for Portal UI model-driven rendering.
 */
module.exports = {
    workflow: {
        description: 'Executable workflow templates and sequences',
        idField: 'id',
        nameField: 'name',
        searchFields: ['id', 'name', 'category', 'desc'],
        displayFields: ['id', 'name', 'category', 'status'],
        fields: {
            id: { type: 'string', description: 'Unique identifier for the workflow' },
            name: { type: 'string', description: 'Human-readable name' },
            category: { type: 'string', description: 'Business category' },
            desc: { type: 'string', description: 'Detailed description of the workflow' },
            status: { type: 'string', description: 'Lifecycle status (PENDING_REVIEW/ACTIVE/REJECTED/DEPRECATED/DELETED)' },
            priority: { type: 'number', description: 'Execution priority (higher is more important)' }
        }
    }
};
