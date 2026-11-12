/**
 * Native Ollama Provider (`api/core/agent/providers/ollama.js`)
 *
 * Calls Ollama's native `/api/chat` endpoint directly instead of the OpenAI-compatible
 * `/v1/chat/completions` shim.
 *
 * Why native `/api/chat`:
 *   1. Apple Silicon MLX backend (`Ollama 0.40.x` running `qwen3.5:9b`) returns
 *      `HTTP 501 ("structured output is unavailable")` when OpenAI SDK sends
 *      `response_format: { type: "json_object" }`.
 *   2. Native `/api/chat` accepts top-level `think: false` (preventing 9B Chain-of-Thought
 *      from stalling synchronous RPCs) and `keep_alive: "30m"` (keeping weights resident in
 *      unified memory across cron/sentinel intervals).
 *   3. Native multimodal `messages[].images` accepts raw base64 strings directly.
 */

const PromptBuilder = require('../logic/prompt');
const tokenLogger = require('../lib/tokenLogger');
const { createLogger } = require('../../../library/logger');

const logger = createLogger('agent');

function stripOllamaPrefix(model, fallback = 'qwen3.5:9b') {
    const raw = String(model || '').trim();
    if (!raw || raw.toLowerCase() === 'ollama') return fallback;
    const stripped = raw.replace(/^ollama[/:]/i, '').trim();
    return stripped || fallback;
}

function stripBase64DataUrl(input) {
    return String(input || '').replace(/^data:[^;]+;base64,/i, '').trim();
}

/**
 * Resiliently extract a JSON object from LLM text output without relying on
 * `response_format: { type: 'json_object' }`.
 * Strips `<think>...</think>` blocks and markdown code fences, then extracts
 * the outermost `{ ... }` object.
 */
function extractJsonObject(rawText) {
    if (typeof rawText !== 'string') return null;
    const cleaned = rawText
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```(?:json)?\s*/gi, '')
        .replace(/```/g, '')
        .trim();

    if (!cleaned) return null;

    try {
        const direct = JSON.parse(cleaned);
        if (direct && typeof direct === 'object') return direct;
    } catch (_) { }

    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        const candidate = cleaned.slice(firstBrace, lastBrace + 1);
        try {
            return JSON.parse(candidate);
        } catch (_) { }
    }
    return null;
}

class OllamaProvider {
    constructor(config = {}) {
        this.config = config;
        this.baseUrl = String(config.ollamaBaseUrl || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
        this.defaultModel = config.ollamaDefaultModel || process.env.OLLAMA_MODEL || 'qwen3.5:9b';
        this.keepAlive = config.ollamaKeepAlive || process.env.OLLAMA_KEEP_ALIVE || '30m';
        this.defaultThink = typeof config.ollamaThink === 'boolean'
            ? config.ollamaThink
            : process.env.OLLAMA_THINK === 'true';
        this.timeoutMs = Number(config.ollamaTimeoutMs || process.env.OLLAMA_TIMEOUT_MS || 60000);
        this.fetchFn = config.fetchFn || global.fetch;
    }

    resolveModel(model) {
        return stripOllamaPrefix(model, this.defaultModel);
    }

    /**
     * Low-level call to Ollama `POST /api/chat`.
     * Deliberately NEVER includes `response_format`.
     */
    async _callChat({ method, model, messages, think, options, keepAlive }) {
        const targetModel = this.resolveModel(model);
        const useThink = typeof think === 'boolean' ? think : this.defaultThink;
        const payload = {
            model: targetModel,
            messages,
            stream: false,
            keep_alive: keepAlive || this.keepAlive,
            think: useThink,
        };
        if (options && typeof options === 'object') {
            payload.options = options;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        if (timer && typeof timer.unref === 'function') timer.unref();

        let data;
        try {
            const res = await this.fetchFn(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            const rawText = await res.text();
            if (!res.ok) {
                throw new Error(`Ollama HTTP ${res.status}: ${rawText.slice(0, 300)}`);
            }
            data = JSON.parse(rawText);
        } finally {
            clearTimeout(timer);
        }

        const inputTokens = Number(data?.prompt_eval_count) || 0;
        const outputTokens = Number(data?.eval_count) || 0;
        const totalTokens = inputTokens + outputTokens;

        tokenLogger.log({
            method,
            model: targetModel,
            provider: 'ollama',
            inputTokens,
            outputTokens,
        });

        const content = String(data?.message?.content || '').trim();
        return {
            targetModel,
            content,
            usage: { inputTokens, outputTokens, totalTokens },
            raw: data,
        };
    }

    async chat(params = {}) {
        const { text, model, think, options } = params;
        const lang = this.config.language || 'zh';
        const prompt = PromptBuilder.buildChat(text, this.config, lang);
        const { targetModel, content, usage } = await this._callChat({
            method: 'agent.chat',
            model,
            messages: [{ role: 'user', content: prompt }],
            think,
            options,
        });
        return {
            success: true,
            text: content,
            metadata: { provider: 'ollama', model: targetModel, usage },
        };
    }

    async parseText(params = {}) {
        const { text, schema, model, think } = params;
        const prompt = [
            'Analyze the following text and extract structured information according to this JSON schema:',
            JSON.stringify(schema || {}, null, 2),
            '',
            `Text: "${text}"`,
            '',
            'Return ONLY valid JSON without markdown explanation.',
        ].join('\n');

        const { targetModel, content, usage } = await this._callChat({
            method: 'agent.text.parse',
            model,
            messages: [{ role: 'user', content: prompt }],
            think,
            options: { temperature: 0 },
        });

        const parsed = extractJsonObject(content);
        if (!parsed) {
            throw new Error(`Ollama parseText returned non-JSON output: ${content.slice(0, 160)}`);
        }
        return {
            success: true,
            data: parsed,
            metadata: { provider: 'ollama', model: targetModel, usage },
        };
    }

    async translateText(params = {}) {
        const { text, targetLang = 'en', sourceLang = 'auto', domain = 'general', model, think } = params;
        const prompt = [
            `Translate the following ${domain} text from ${sourceLang} to ${targetLang}.`,
            'Return ONLY the translated text without quotes or explanations.',
            '',
            String(text || ''),
        ].join('\n');

        const { targetModel, content, usage } = await this._callChat({
            method: 'agent.text.translate',
            model,
            messages: [{ role: 'user', content: prompt }],
            think,
            options: { temperature: 0.1 },
        });

        return {
            success: true,
            translatedText: content,
            sourceLang: sourceLang || 'auto',
            metadata: { provider: 'ollama', model: targetModel, usage },
        };
    }

    async parseImage(params = {}) {
        const { image, images, prompt, scene = 'general', lang = 'zh', model, think } = params;
        const imgList = [];
        if (image) imgList.push(stripBase64DataUrl(image));
        if (Array.isArray(images)) {
            for (const img of images) {
                if (img) imgList.push(stripBase64DataUrl(img));
            }
        }
        const effectivePrompt = prompt || (lang === 'en'
            ? `Extract all visible text and structured details from this ${scene} image.`
            : `请精准识别并提取该图片（场景：${scene}）中的全部文字与关键结构化信息。`);

        const { targetModel, content, usage } = await this._callChat({
            method: 'agent.image.parse',
            model,
            messages: [{
                role: 'user',
                content: effectivePrompt,
                images: imgList,
            }],
            think,
        });

        const maybeJson = extractJsonObject(content);
        return {
            success: true,
            text: content,
            ...(maybeJson ? { data: maybeJson } : {}),
            metadata: { provider: 'ollama', model: targetModel, usage },
        };
    }

    async extractProductInfo(params = {}) {
        const { image, images, lang = 'zh', categoryAttrs, model, think } = params;
        const imgList = [];
        if (image) imgList.push(stripBase64DataUrl(image));
        if (Array.isArray(images)) {
            for (const img of images) {
                if (img) imgList.push(stripBase64DataUrl(img));
            }
        }
        const attrHint = Array.isArray(categoryAttrs) && categoryAttrs.length > 0
            ? `重点提取属性：${categoryAttrs.map((a) => a.name || a).join('、')}。`
            : '';
        const prompt = [
            `请从商品图片中提取结构化商品信息（语言：${lang}）。${attrHint}`,
            '仅输出合法 JSON 对象，字段包含：name, brand, model, specs, sellingPoints, rawText。',
        ].join('\n');

        const { targetModel, content, usage } = await this._callChat({
            method: 'agent.image.parse',
            model,
            messages: [{
                role: 'user',
                content: prompt,
                images: imgList,
            }],
            think,
            options: { temperature: 0 },
        });

        const parsed = extractJsonObject(content) || { rawText: content };
        return {
            success: true,
            data: parsed,
            metadata: { provider: 'ollama', model: targetModel, usage },
        };
    }

    async scanLabel(params = {}) {
        const { image, model, think } = params;
        const base64 = stripBase64DataUrl(image);
        const prompt = '识别图片中的商品标签、SKU编码与条形码。只输出合法 JSON 对象：{"sku": "...", "barcode": "..."}';

        const { content } = await this._callChat({
            method: 'agent.label.scan',
            model,
            messages: [{
                role: 'user',
                content: prompt,
                images: base64 ? [base64] : [],
            }],
            think,
            options: { temperature: 0 },
        });

        const parsed = extractJsonObject(content) || {};
        return {
            success: true,
            sku: String(parsed.sku || ''),
            barcode: String(parsed.barcode || ''),
        };
    }

    async classifyImage(params = {}) {
        const { image, categories = [], model, think } = params;
        const base64 = stripBase64DataUrl(image);
        const prompt = [
            '请根据图片内容从以下候选类目中选择最匹配的一项：',
            JSON.stringify(categories),
            '只输出合法 JSON 对象：{"categoryId": "...", "categoryName": "...", "confidence": 0.9, "reason": "..."}',
        ].join('\n');

        const { targetModel, content, usage } = await this._callChat({
            method: 'agent.image.classify',
            model,
            messages: [{
                role: 'user',
                content: prompt,
                images: base64 ? [base64] : [],
            }],
            think,
            options: { temperature: 0 },
        });

        const parsed = extractJsonObject(content) || {};
        return {
            success: true,
            categoryId: String(parsed.categoryId || ''),
            categoryName: String(parsed.categoryName || ''),
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
            reason: String(parsed.reason || content),
            metadata: { provider: 'ollama', model: targetModel, usage },
        };
    }

    /**
     * decide — structured decision via native Ollama `/api/chat` without `response_format`.
     * Returns `{ success: false }` on network/parse error so `logic/decide.js` degrades
     * cleanly to `{ decision: null, escalate: true }`.
     */
    async decide({ instruction, context, choices, schema, model, think }) {
        const targetModel = this.resolveModel(model);
        const prompt = PromptBuilder.buildDecide({ instruction, context, choices, schema });
        try {
            const { content, usage } = await this._callChat({
                method: 'agent.decide',
                model: targetModel,
                messages: [{ role: 'user', content: prompt }],
                think,
                options: { temperature: 0 },
            });
            const data = extractJsonObject(content);
            if (!data || typeof data !== 'object') {
                return {
                    success: false,
                    error: 'Ollama decide output did not contain a valid JSON object',
                    metadata: { provider: 'ollama', model: targetModel, usage },
                };
            }
            return {
                success: true,
                data,
                metadata: { provider: 'ollama', model: targetModel, usage },
            };
        } catch (error) {
            logger.error('[Ollama] Decide Error:', error.message);
            return {
                success: false,
                error: error.message,
                metadata: { provider: 'ollama', model: targetModel },
            };
        }
    }

    async focus({ text, memory, workflow, currentParams, missingFields, model, think }) {
        const lang = this.config.language || 'zh';
        const prompt = PromptBuilder.buildFocus(text, memory, workflow, currentParams, missingFields, lang);
        const { targetModel, content, usage } = await this._callChat({
            method: 'agent.focus',
            model,
            messages: [{ role: 'user', content: prompt }],
            think,
            options: { temperature: 0 },
        });
        const parsed = extractJsonObject(content) || {};
        return {
            extracted_params: parsed.extracted_params || {},
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
            hint: String(parsed.hint || ''),
            action: String(parsed.action || 'ask'),
            metadata: { provider: 'ollama', model: targetModel, usage },
        };
    }

    async suggestCategoryAttrs({ categoryPath, model, think }) {
        const { system, user } = PromptBuilder.buildCategoryAttrSuggest(categoryPath);
        const { content } = await this._callChat({
            method: 'agent.text.parse',
            model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            think,
            options: { temperature: 0 },
        });
        const parsed = extractJsonObject(content);
        if (!parsed) {
            throw new Error('Failed to parse category attributes JSON from Ollama');
        }
        return parsed;
    }
}

module.exports = OllamaProvider;
module.exports.stripOllamaPrefix = stripOllamaPrefix;
module.exports.extractJsonObject = extractJsonObject;
