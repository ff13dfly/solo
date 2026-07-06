/**
 * Distinct Builder for AI Prompt Pre-rendering
 * 
 * @why Flattens complex workflow definitions into a concise, AI-optimized 
 *      format (snapshots) to minimize LLM token consumption and improve 
 *      intent detection speed.
 * @attention Used primarily by the `orchestrator.workflow.build` method.
 */

// --- AI METADATA GENERATOR ---

class Distinct {
    /**
     * Build AI Metadata for a workflow
     * @param {object} workflow - The workflow object
     * @param {string} lang - Language code (default 'zh')
     * @returns {object} ai_meta object
     */
    static buildAiMeta(workflow, lang = 'zh') {
        const meta = {
            intent_desc_zh: '', // We can support multiple languages in one meta object if needed, or rely on snapshots
            intent_desc_en: '',
            intent_tokens: 0,
            field_config: {}
        };

        // 1. Intent Description
        // Format: - [ID: {id}] [工作流: {name}]: {desc}
        meta.intent_desc_zh = `- [ID: ${workflow.id}] [工作流: ${workflow.name}]: ${workflow.desc || ''}`;
        meta.intent_desc_en = `- [ID: ${workflow.id}] [Workflow: ${workflow.name}]: ${workflow.desc || ''}`; // Simple fallback if no EN data

        // Calculate tokens (Approx: Char / 3 for Chinese/English mix)
        meta.intent_tokens = Math.ceil(meta.intent_desc_zh.length / 1.5); // Liberal estimate

        // 2. Field Config (Focus Mode Hints)
        const allInputs = [...(workflow.required_inputs || []), ...(workflow.optional_inputs || [])];
        const uniqueInputs = [...new Set(allInputs)];

        uniqueInputs.forEach(field => {
            // A. Get Synonyms
            const synList = workflow.synonyms?.[field] || [];

            // B. Infer Label
            // Policy: Use first synonym as Label, fallback to Code Name
            // If synList is empty, Frontend should have warned user. Here we just degrade gracefully.
            const prettyName = synList.length > 0 ? synList[0] : field;

            // C. Build Hint String
            // Format: - field (说明: label, 又名: syn1, syn2)
            let synHint = '';
            if (synList.length > 0) {
                synHint = ` (说明: ${prettyName}, 又名: ${synList.join(', ')})`;
            }
            
            // Store result
            const line = `- ${field}${synHint}`;
            meta.field_config[field] = {
                text: line,
                tokens: Math.ceil(line.length / 1.5)
            };
        });

        return meta;
    }
}

module.exports = Distinct;
