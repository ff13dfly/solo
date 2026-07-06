const { STATUS } = require('../../../library/constants');

module.exports = {
    "agenda": {
        name: "agenda",
        description: "A time block in the calendar",
        fields: {
            "id": { type: "string", description: "Unique identifier (ag_*)", required: true },
            "userId": { type: "string", description: "Owner of the agenda", required: true },
            "title": { type: "string", description: "Agenda title", required: true },
            "date": { type: "string", description: "Event date (YYYY-MM-DD)", required: true },
            "content": { type: "string", description: "Details or notes" },
            "startTime": { type: "string", description: "Start time (HH:mm)", required: true },
            "endTime": { type: "string", description: "End time (HH:mm)", required: true },
            "todoId": { type: "string", description: "Linked Todo ID" },
            "status": { type: "enum", options: ["SCHEDULED", "BUSY", "DONE", "CANCELLED"], description: "Agenda status" },
            "ext": { type: "object", description: "Extensible metadata" },
            "createdAt": { type: "datetime", description: "Creation timestamp" }
        }
    },
    "todo": {
        name: "todo",
        description: "A long-term project or task tracked in Markdown",
        fields: {
            "id": { type: "string", description: "Unique identifier (todo_*)", required: true },
            "userId": { type: "string", description: "Owner of the todo", required: true },
            "name": { type: "string", description: "Todo name", required: true },
            "content": { type: "string", description: "Markdown content" },
            "status": { type: "enum", options: ["PENDING", "IN_PROGRESS", "COMPLETED", "ARCHIVED", STATUS.DELETED], description: "Todo status" },
            "priority": { type: "enum", options: ["LOW", "NORMAL", "HIGH", "URGENT"], description: "Task urgency level" },
            "tags": { type: "array", description: "List of tags" },
            "relatedAgendas": { type: "array", description: "List of related agenda IDs" },
            "ext": { type: "object", description: "Extensible metadata" },
            "updatedAt": { type: "datetime", description: "Last update timestamp" }
        }
    }
};
