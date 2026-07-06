/**
 * Capability Builder for Router
 * 
 * Responsibilities:
 * 1. Merge introspection data (JSDoc/Code) with Config manual descriptions.
 * 2. Generate AI-ready prompt lines for Capabilities.
 * 3. Support Multilingual generation (ZH/EN).
 */

class CapabilityBuilder {
    /**
     * Build Capability Metadata
     * @param {string} serviceName - Service name (e.g. 'crm')
     * @param {Array} rawCaps - Introspection capabilities
     * @param {Object} serviceConfig - Service configuration object
     * @returns {Object} { zh: [], en: [] }
     */
    static buildCapabilityMeta(serviceName, rawCaps, serviceConfig) {
        const result = {
            zh: [],
            en: []
        };

        if (!rawCaps || !Array.isArray(rawCaps)) return result;

        const manualDesc = serviceConfig?.description || {};

        rawCaps.forEach(method => {
            // 1. Resolve Description (ZH)
            // Priority: Config (zh) -> Code Desc -> Config (en) fallback
            const configZh = manualDesc.zh?.methods?.[method.name];
            const finalDescZh = configZh 
                ? (Array.isArray(configZh) ? configZh.join('; ') : configZh)
                : (method.description || method.desc);

            // 2. Resolve Description (EN)
            const configEn = manualDesc.en?.methods?.[method.name];
            // If explicit EN config exists, use it. Otherwise try method.description (which is likely EN/Mixed)
            const finalDescEn = configEn 
                ? (Array.isArray(configEn) ? configEn.join('; ') : configEn)
                : (method.description || method.desc); // Fallback to raw dec

            // 3. Build Prompt Line
            // Format: - [APB: {name}]: {desc}
            // APB = Atomic Protocol Block (API)
            if (finalDescZh) {
                result.zh.push(`- [API: ${method.name}]: ${finalDescZh}`);
            }
            if (finalDescEn) {
                result.en.push(`- [API: ${method.name}]: ${finalDescEn}`);
            }
        });

        return result;
    }
}

module.exports = CapabilityBuilder;
