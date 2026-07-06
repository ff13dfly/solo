module.exports = {
    "sentinel": {
        description: "A Sentinel — an event-subscribed, declarative, optionally AI-backed reactor",
        softDelete: true,
        fields: {
            "id":                  { type: "string", description: "Sentinel id", required: true },
            "name":                { type: "string", description: "Display name", required: true },
            "description":         { type: "string", description: "Role description" },
            "authorityRole":       { type: "string", description: "The Sentinel's identity bot uid. A `system.*` value (a Bot Account in portal/system) with a provisioned token (nexus.sentinel.token.set) makes the Sentinel's data_fetchers run under THIS bot's least-privilege permit (§1.2); a non-system.* value is descriptive only and falls back to the shared nexus identity." },
            "track":               { type: "enum",   options: ["internal", "external"], description: "Internal bot vs external app" },
            "eventSubscriptions":  { type: "array",  description: "Stream keys this Sentinel listens to" },
            "reachability":        { type: "string", options: ["built-in", "polling", "sse", "webhook"], description: "How the Sentinel receives events: built-in (host-embedded), polling (inbox), sse, or webhook" },
            "webhookUrl":          { type: "string", description: "Delivery endpoint for webhook reachability; used by nexus.sentinel.broadcast to configure notification" },
            "context":             { type: "object", description: "Declarative context assembly (context.md): { guard, data_fetchers[], system_prompt_template }. Nexus pre-fetches read-only data + renders the prompt before delivering. Null = deliver raw event." },
            "status":              { type: "enum",   options: ["ACTIVE", "DISABLED"], description: "Lifecycle state" },
            "lastSeenAt":          { type: "datetime", description: "Most recent heartbeat" },
            "createdAt":           { type: "datetime", description: "Profile creation timestamp" }
        }
    }
};
