/**
 * Entity Schema Definitions
 * 
 * @why Provides a machine-readable definition of the data structures managed 
 *      by this service. The Router uses this to provide "extraction hints" 
 *      to the AI and to generate dynamic UI forms.
 */

// --- DATA ENTITIES ---

module.exports = {
    "asset": {
        description: "A digital asset (file) stored in the system",
        fields: {
            "id": { type: "string", description: "System ID (BS58)", required: true },
            "originalName": { type: "string", description: "Original filename" },
            "mimeType": { type: "string", description: "MIME type (e.g., image/png)" },
            "size": { type: "integer", description: "File size in bytes" },
            "sha256": { type: "string", description: "SHA256 content hash" },
            "key": { type: "string", description: "Object-store key (CAS 2/2/2 path)" },
            "path": { type: "string", description: "Relative storage path (legacy alias of key)" },
            "url": { type: "string", description: "Absolute object-store (OSS/CDN) URL" },
            "thumbnails": { type: "object", description: "Map of size (sm/md/lg) → thumbnail URL, for images" },
            "owner": { type: "string", description: "Uploader UID (per-asset authorization; null = legacy/unowned)" },
            "visibility": { type: "string", description: "Access tier: public | internal (any authenticated) | private (owner/admin only)" },
            "createdAt": { type: "datetime", description: "Upload timestamp" }
        }
    }
};
