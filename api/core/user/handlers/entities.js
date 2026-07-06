/**
 * User Service Entity Schema Definitions
 * 
 * @why Provides machine-readable definitions of the data structures.
 *      The Router uses this to provide "extraction hints" to the AI and 
 *      to generate dynamic UI forms.
 */

// --- DATA ENTITIES ---

module.exports = {
    "user": {
        description: "Core user profile and account information",
        fields: {
            "id": { type: "string", description: "Unique Base58 user ID", required: true },
            "name": { type: "string", description: "Username used for login", required: true },
            "email": { type: "string", description: "Email address" },
            "phone": { type: "string", description: "Mobile phone number" },
            "lang": { type: "string", description: "Preferred language (e.g., zh, en)" },
            "status": { type: "enum", options: ["ACTIVE", "DELETED"], description: "Account lifecycle status" },
            "create": { type: "datetime", description: "Registration timestamp" },
            "last": { type: "datetime", description: "Last login/activity timestamp" },
            "categories": { type: "object", description: "User-specific category assignments" }
        }
    },
    "permit": {
        description: "Access control permissions for a user",
        fields: {
            "allow_all": { type: "boolean", description: "Administrator flag", required: true },
            "services": { type: "object", description: "Map of service names to allowed methods" }
        }
    },
    "category": {
        description: "Classification and grouping system",
        fields: {
            "id": { type: "string", description: "Unique Base58 category ID", required: true },
            "key": { type: "string", description: "System key (e.g., ROLE)", required: true },
            "type": { type: "enum", options: ["LIST", "TREE"], description: "Structure type", required: true },
            "desc": { type: "string", description: "Human-readable description" },
            "scope": { type: "string", description: "Visibility scope (GLOBAL/LOCAL)" },
            "items": { type: "array", description: "List of items in the category" }
        }
    }
};
