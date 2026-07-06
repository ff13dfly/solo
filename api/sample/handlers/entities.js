const { STATUS } = require('../../library/constants');

module.exports = {
    "item": {
        description: "A sample entity for demonstration",
        softDelete: true,
        fields: {
            "id": { type: "string", description: "Unique identifier", required: true },
            "name": { type: "string", description: "Entity name", required: true },
            "status": { type: "enum", options: [STATUS.ACTIVE, STATUS.DELETED], description: "Entity status" },
            "createdAt": { type: "datetime", description: "Creation timestamp" }
        }
    }
};
