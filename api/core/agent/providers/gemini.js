const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createLogger } = require('../../../library/logger');
const tokenLogger = require('../lib/tokenLogger');
const logger = createLogger('agent');

/**
 * Gemini Provider
 * @why Implements the Agent's reasoning using Google's Gemini models.
 * @attention Used as the default primary provider for the Agent service.
 */
class GeminiProvider {
    // --- INITIALIZATION ---
    constructor(config) {
        this.config = config;
        this.genAI = new GoogleGenerativeAI(config.geminiApiKey);
    }

    // --- MULTIMODAL CAPABILITIES ---

    async extractProductInfo({ images, images: legacyImages, meta, model, schema }) {
        logger.info('[Gemini] Extracting Product Info...');
        const targetModel = model || "gemini-2.5-flash";
        const imagesToProcess = images || (legacyImages ? [legacyImages] : []);

        try {
            const genModel = this.genAI.getGenerativeModel({ model: targetModel });
            const PromptBuilder = require('../logic/prompt');
            const lang = this.config.language || 'zh';
            const prompt = PromptBuilder.buildProductExtraction(lang, schema, meta);

            const parts = [prompt];

            for (const img of imagesToProcess) {
                const data = typeof img === 'string' ? img : (img.data || img.image || '');
                const base64Data = data.replace(/^data:image\/\w+;base64,/, "");
                parts.push({
                    inlineData: {
                        data: base64Data,
                        mimeType: "image/jpeg",
                    },
                });
            }

            const result = await genModel.generateContent(parts);
            const response = await result.response;
            const text = response.text();

            try {
                const match = text.match(/\{[\s\S]*\}/);
                if (match) {
                    return {
                        success: true,
                        data: JSON.parse(match[0]),
                        metadata: { provider: 'gemini', model: targetModel }
                    };
                }
            } catch (e) {
                logger.warn('[Gemini] Failed to parse product JSON, returning raw text');
            }

            const usage = result.response?.usageMetadata;
            if (usage) tokenLogger.log({ method: 'agent.image.parse', model: targetModel, provider: 'gemini', inputTokens: usage.promptTokenCount || 0, outputTokens: usage.candidatesTokenCount || 0 });
            return {
                success: true,
                data: { text },
                metadata: { provider: 'gemini', model: targetModel }
            };

        } catch (error) {
            logger.error('[Gemini] Product Extraction Error:', error);
            throw error;
        }
    }

    async parseImage({ image, prompt, model }) {
        logger.info('[Gemini] Parsing Image...');
        const targetModel = model || "gemini-1.5-flash";
        try {
            // Use specified model or default to gemini-2.5-flash
            const genModel = this.genAI.getGenerativeModel({ model: targetModel });

            // image is expected to be base64 string
            // Remove header if present (data:image/jpeg;base64,)
            const base64Data = image.replace(/^data:image\/\w+;base64,/, "");

            const imagePart = {
                inlineData: {
                    data: base64Data,
                    mimeType: "image/jpeg",
                },
            };

            const result = await genModel.generateContent([prompt || "Describe this image", imagePart]);
            const response = await result.response;
            const text = response.text();

            const usage = response.usageMetadata;
            const usageData = usage ? {
                inputTokens: usage.promptTokenCount,
                outputTokens: usage.candidatesTokenCount,
                totalTokens: usage.totalTokenCount
            } : null;

            if (usage) {
                tokenLogger.log({ 
                    method: 'agent.image.parse', 
                    model: targetModel, 
                    provider: 'gemini', 
                    inputTokens: usage.promptTokenCount, 
                    outputTokens: usage.candidatesTokenCount 
                });
            }

            // Try to parse JSON if the prompt requested it
            try {
                // Find JSON-like structure
                const match = text.match(/\{[\s\S]*\}/);
                if (match) {
                    return {
                        success: true,
                        data: JSON.parse(match[0]),
                        metadata: { provider: 'gemini', model: targetModel, usage: usageData }
                    };
                }
            } catch (e) {
                // If not JSON, return text
            }

            return {
                success: true,
                data: { text },
                metadata: { provider: 'gemini', model: targetModel, usage: usageData }
            };

        } catch (error) {
            logger.error('[Gemini] Image Error:', error);
            throw error;
        }
    }

    async transcribeAudio({ audio, mimeType, model }) {
        logger.info('[Gemini] Transcribing Audio...');
        const targetModel = model || "gemini-1.5-flash";
        try {
            const genModel = this.genAI.getGenerativeModel({ model: targetModel });

            const base64Data = audio.replace(/^data:audio\/\w+;base64,/, "");
            const audioPart = {
                inlineData: {
                    data: base64Data,
                    mimeType: mimeType || "audio/mp3",
                },
            };

            const result = await genModel.generateContent(["Transcribe this audio and detect the language. Format: [Language] Text.", audioPart]);
            const response = await result.response;
            const text = response.text();

            const usage = response.usageMetadata;
            const usageData = usage ? {
                inputTokens: usage.promptTokenCount,
                outputTokens: usage.candidatesTokenCount,
                totalTokens: usage.totalTokenCount
            } : null;

            if (usage) {
                tokenLogger.log({ 
                    method: 'agent.audio.transcribe', 
                    model: targetModel, 
                    provider: 'gemini', 
                    inputTokens: usage.promptTokenCount, 
                    outputTokens: usage.candidatesTokenCount 
                });
            }

            return {
                success: true,
                text: text,
                metadata: { provider: 'gemini', model: targetModel, usage: usageData }
            };

        } catch (error) {
            logger.error('[Gemini] Audio Error:', error);
            throw error;
        }
    }

    // --- TEXT ANALYSIS & EXTRACTION ---

    async parseText({ text, schema, model }) {
        logger.info('[Gemini] Parsing Text...');
        const targetModel = model || "gemini-1.5-flash";
        try {
            const genModel = this.genAI.getGenerativeModel({ model: targetModel });

            const prompt = `
                Analyze the following text and extract information according to this schema:
                ${JSON.stringify(schema, null, 2)}
                
                Text: "${text}"
                
                Return ONLY valid JSON.
            `;

            const result = await genModel.generateContent(prompt);
            const response = await result.response;
            const output = response.text();

            const usage = response.usageMetadata;
            if (usage) tokenLogger.log({ method: 'agent.text.parse', model: targetModel, provider: 'gemini', inputTokens: usage.promptTokenCount || 0, outputTokens: usage.candidatesTokenCount || 0 });
            const match = output.match(/\{[\s\S]*\}/);
            if (match) {
                return {
                    success: true,
                    data: JSON.parse(match[0]),
                    metadata: { provider: 'gemini', model: targetModel }
                };
            }

            throw new Error("Failed to parse JSON response");

        } catch (error) {
            logger.error('[Gemini] Text Error:', error);
            throw error;
        }
    }

    // --- STRUCTURED DECISION (agent.decide) ---

    /**
     * decide — structured decision via JSON-mode completion.
     * @why Backs agent.decide. Returns parsed JSON ({ decision, confidence, reason, fields? });
     *      the logic layer enforces the inverted gate + degradability. Returns
     *      { success:false } on any non-network error so the caller can fail-soft.
     */
    async decide({ instruction, context, choices, schema, model }) {
        logger.info('[Gemini] Decide...');
        const targetModel = model || 'gemini-2.5-flash-lite';
        const PromptBuilder = require('../logic/prompt');
        const prompt = PromptBuilder.buildDecide({ instruction, context, choices, schema });
        try {
            const genModel = this.genAI.getGenerativeModel({
                model: targetModel,
                generationConfig: { responseMimeType: 'application/json', temperature: 0 },
            });
            const result = await genModel.generateContent(prompt);
            const response = await result.response;
            const text = response.text();
            const usage = response.usageMetadata;
            if (usage) tokenLogger.log({ method: 'agent.decide', model: targetModel, provider: 'gemini', inputTokens: usage.promptTokenCount || 0, outputTokens: usage.candidatesTokenCount || 0 });
            const match = text.match(/\{[\s\S]*\}/);
            const data = JSON.parse(match ? match[0] : text);
            return { success: true, data, metadata: { provider: 'gemini', model: targetModel } };
        } catch (error) {
            logger.error('[Gemini] Decide Error:', error.message);
            return { success: false, error: error.message, metadata: { provider: 'gemini', model: targetModel } };
        }
    }

    // --- INTENT DETECTION (LEGACY & MULTI-STEP) ---


    async identifyPurpose({ text, image, capabilities, model, noWorkflow }) {
        logger.info(`[Gemini] Identifying Purpose (Multi-Step)${noWorkflow ? ' [noWorkflow]' : ''}...`);
        const targetModel = model || "gemini-1.5-flash";
        const lang = this.config.language || 'en';

        const CapabilityManager = require('../logic/CapabilityManager');

        // --- STEP 1: Service Selection ---
        const serviceDesc = CapabilityManager.getServiceDescriptions(lang);
        const prompt1 = this._buildStep1Prompt(text, serviceDesc, lang);

        let step1Res;
        try {
            const genModel = this.genAI.getGenerativeModel({ model: targetModel });
            step1Res = await genModel.generateContent(prompt1);
        } catch (e) {
            logger.error('[Gemini] Step 1 Failed:', e);
            return 'agent.chat';
        }

        const content1 = step1Res.response.text();
        logger.debug(`[Gemini] Step 1 Result: ${content1}`);
        const usage1 = step1Res.response.usageMetadata;
        if (usage1) tokenLogger.log({ method: 'agent.purpose', model: targetModel, provider: 'gemini', inputTokens: usage1.promptTokenCount || 0, outputTokens: usage1.candidatesTokenCount || 0 });

        let services = [];
        try {
            const match = content1.match(/\[.*\]/s);
            if (match) services = JSON.parse(match[0]);
        } catch (e) { logger.warn('JSON Parse Error Step 1'); }

        const selectedService = services[0];
        if (!selectedService || selectedService === 'other' || selectedService === 'agent') {
            return 'agent.chat';
        }

        // --- STEP 2: Method Selection ---
        const methodDesc = CapabilityManager.getMethodsForService(selectedService, lang);
        const prompt2 = this._buildStep2Prompt(text, methodDesc, lang);

        let step2Res;
        try {
            const genModel = this.genAI.getGenerativeModel({ model: targetModel });
            step2Res = await genModel.generateContent(prompt2);
        } catch (e) {
            logger.error('[Gemini] Step 2 Failed:', e);
            return 'agent.chat';
        }

        const content2 = step2Res.response.text();
        logger.debug(`[Gemini] Step 2 Result: ${content2}`);
        const usage2 = step2Res.response.usageMetadata;
        if (usage2) tokenLogger.log({ method: 'agent.purpose', model: targetModel, provider: 'gemini', inputTokens: usage2.promptTokenCount || 0, outputTokens: usage2.candidatesTokenCount || 0 });

        let methods = [];
        try {
            const match = content2.match(/\[.*\]/s);
            if (match) methods = JSON.parse(match[0]);
        } catch (e) { console.warn('JSON Parse Error Step 2'); }

        if (methods.length > 0 && methods[0] !== 'other' && methods[0] !== 'null') {
            return methods[0];
        }

        return 'agent.chat';
    }

    _buildStep1Prompt(input, serviceDesc, lang) {
        if (lang === 'zh') {
            return `
请分析用户输入属于哪个服务领域。
[服务列表]:
${serviceDesc}
- agent: 一般闲聊、问答、无法归类到上述服务的内容

用户输入: "${input}"

规则:
1. 如果匹配，返回 ["服务名"] (例如 ["crm"])
2. 如果不匹配或为闲聊，返回 ["agent"]
3. 严格遵守服务描述中的否定约束（例如"不用于..."）。
4. 仅返回JSON数组。
`;
        } else {
            return `
Analyze which service domain the user input belongs to.
[Services]:
${serviceDesc}
- agent: General chat, Q&A, or anything not fitting the above services

User Input: "${input}"

Rules:
1. If matched, return ["serviceName"] (e.g. ["crm"])
2. If not matched or general chat, return ["agent"]
3. Strictly adhere to negative constraints in descriptions (e.g. "NOT for...").
4. Return ONLY a JSON array.
`;
        }
    }

    _buildStep2Prompt(input, methodDesc, lang) {
        if (lang === 'zh') {
            return `
请从以下功能中选择最匹配的一项。
[功能列表]:
${methodDesc}

用户输入: "${input}"

规则:
1. 必须从列表中选择一项。
2. 如果没有合适的，返回 ["other"]
3. 仅返回JSON数组。
`;
        } else {
            return `
Select the most matching function from the list.
[Functions]:
${methodDesc}

User Input: "${input}"

Rules:
1. Must select one from the list.
2. If none match, return ["other"]
3. Return ONLY a JSON array.
`;
        }
    }

    async chat({ text, messages, model }) {
        logger.info('[Gemini] Chatting...');
        const targetModel = model || "gemini-1.5-flash";
        const lang = this.config.language || 'en';
        const PromptBuilder = require('../logic/prompt');

        try {
            const genModel = this.genAI.getGenerativeModel({ model: targetModel });
            
            // Support standardized messages array
            if (messages && Array.isArray(messages)) {
                const contents = [];
                let systemInstruction = "";

                for (const msg of messages) {
                    if (msg.role === 'system') {
                        systemInstruction = msg.content;
                        continue;
                    }

                    const parts = [];
                    if (typeof msg.content === 'string') {
                        parts.push({ text: msg.content });
                    } else if (Array.isArray(msg.content)) {
                        for (const part of msg.content) {
                            if (part.type === 'text') {
                                parts.push({ text: part.text });
                            } else if (part.type === 'image_url') {
                                const base64Data = part.image_url.url.replace(/^data:image\/\w+;base64,/, "");
                                parts.push({
                                    inlineData: {
                                        data: base64Data,
                                        mimeType: "image/jpeg"
                                    }
                                });
                            }
                        }
                    }
                    contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts });
                }

                const chatModel = this.genAI.getGenerativeModel({ 
                    model: targetModel,
                    systemInstruction: systemInstruction || undefined
                });

                const result = await chatModel.generateContent({ contents });
                const response = await result.response;
                const usage = response.usageMetadata;
                if (usage) tokenLogger.log({ method: 'agent.chat', model: targetModel, provider: 'gemini', inputTokens: usage.promptTokenCount || 0, outputTokens: usage.candidatesTokenCount || 0 });
                
                return {
                    success: true,
                    content: response.text(),
                    metadata: { provider: 'gemini', model: targetModel }
                };
            }

            // Fallback to legacy text-only prompt
            const prompt = PromptBuilder.buildChat(text, this.config, lang);
            const result = await genModel.generateContent(prompt);
            const response = await result.response;
            const usage = response.usageMetadata;
            if (usage) tokenLogger.log({ method: 'agent.chat', model: targetModel, provider: 'gemini', inputTokens: usage.promptTokenCount || 0, outputTokens: usage.candidatesTokenCount || 0 });
            return {
                success: true,
                text: response.text(),
                content: response.text(),
                metadata: { provider: 'gemini', model: targetModel }
            };
        } catch (error) {
            logger.error('[Gemini] Chat Error:', error);

            // Handle Quota/Rate Limits (429)
            if (error.message && (error.message.includes('429') || error.message.includes('Quota') || error.message.includes('limit'))) {
                return {
                    success: true,
                    text: "⚠️ **API Quota Exceeded**\n\nThe AI service is currently currently unavailable due to usage limits. Please check your [Google Cloud Console Quotas](https://console.cloud.google.com/iam-admin/quotas) or Billing settings.",
                    metadata: { provider: 'gemini', error: 'quota_exceeded' }
                };
            }

            // Handle Authentication Issues
            if (error.message && (error.message.includes('API key') || error.message.includes('403'))) {
                return {
                    success: true,
                    text: "⚠️ **Configuration Error**\n\nThe AI service failed to authenticate. Please check the `GEMINI_API_KEY` configuration on the server.",
                    metadata: { provider: 'gemini', error: 'auth_failed' }
                };
            }

            // Default Error
            return {
                success: true,
                text: `⚠️ **AI Service Error**\n\nI encountered an issue processing your request: ${error.message.substring(0, 100)}...`,
                metadata: { provider: 'gemini', error: 'unknown' }
            };
        }
    }

    // --- MODERN TWO-PHASE INTENT DETECTION ---

    async identifyPurposeWithContext({ text, phase, context, model, noWorkflow }) {
        if (noWorkflow && context.candidates) {
            context.candidates = context.candidates.filter(cap => !cap.includes('[工作流名称:'));
        }
        logger.info(`[Gemini] Purpose Detection - Phase ${phase}${noWorkflow ? ' [noWorkflow]' : ''}`);
        const targetModel = model || "gemini-1.5-flash";
        const lang = this.config.language || 'en';
        const PromptBuilder = require('../logic/prompt');

        if (phase === 1) {
            const prompt = PromptBuilder.buildPhase1(text, context, lang);
            try {
                const genModel = this.genAI.getGenerativeModel({ model: targetModel });
                const response = await genModel.generateContent(prompt);
                const content = response.response.text();
                logger.debug(`[Gemini] Phase 1 Raw: ${content}`);
                const u1 = response.response.usageMetadata;
                if (u1) tokenLogger.log({ method: 'agent.purpose', model: targetModel, provider: 'gemini', inputTokens: u1.promptTokenCount || 0, outputTokens: u1.candidatesTokenCount || 0 });
                const match = content.match(/\{[\s\S]*\}/);
                if (match) {
                    const result = JSON.parse(match[0]);
                    return { services: result.services || [], categories: result.categories || [] };
                }
            } catch (e) {
                logger.error('[Gemini] Phase 1 Error:', e.message);
            }
            return { services: [], categories: [] };
        } else if (phase === 2) {
            const prompt = PromptBuilder.buildPhase2(text, context, lang);
            const systemPrompt = (this.config.systemPrompts && this.config.systemPrompts[lang]) || (this.config.systemPrompts && this.config.systemPrompts['en']) || "You are a helpful assistant.";
            const constraints = (this.config.chatConfig && this.config.chatConfig.constraints && this.config.chatConfig.constraints[lang]) || (this.config.chatConfig && this.config.chatConfig.constraints && this.config.chatConfig.constraints['en']) || "";

            try {
                const genModel = this.genAI.getGenerativeModel({
                    model: targetModel,
                    systemInstruction: systemPrompt
                });
                const response = await genModel.generateContent(prompt);
                const content = response.response.text();
                logger.debug(`[Gemini] Phase 2 Raw: ${content}`);
                const u2 = response.response.usageMetadata;
                if (u2) tokenLogger.log({ method: 'agent.purpose', model: targetModel, provider: 'gemini', inputTokens: u2.promptTokenCount || 0, outputTokens: u2.candidatesTokenCount || 0 });
                const match = content.match(/\{[\s\S]*\}/);
                if (match) {
                    const result = JSON.parse(match[0]);
                    if (result.candidates && Array.isArray(result.candidates)) {
                        return { candidates: result.candidates };
                    }
                }
            } catch (e) {
                logger.error('[Gemini] Phase 2 Error:', e.message);
            }
            return { candidates: [] };
        }
        throw new Error('Invalid phase parameter. Must be 1 or 2.');
    }

    /**
     * Focus: Extract parameters from user input and generate hint
     * @param {object} params - { text, workflow, currentParams, missingFields, model }
     * @returns {object} { extracted_params, confidence, hint, action }
     */
    async focus({ text, workflow, currentParams, missingFields, model }) {
        // ... (existing code)
    }

    // --- LANGUAGE SERVICES ---

    async translateText({ text, targetLang, sourceLang, context, model }) {
        logger.info(`[Gemini] Translating to ${targetLang}...`);
        const targetModel = model || "gemini-1.5-flash";

        try {
            const genModel = this.genAI.getGenerativeModel({ model: targetModel });

            const prompt = `
                Translate the following text to ${targetLang}.
                ${sourceLang ? `Source language: ${sourceLang}` : 'Auto-detect the source language.'}
                ${context ? `Context: ${context}` : ''}
                
                Product-specific rules:
                1. Maintain technical terms and brand names if appropriate.
                2. Use professional, business-appropriate tone.
                
                Text to translate:
                "${text}"
                
                Return ONLY the translated text, no explanation.
            `;

            const result = await genModel.generateContent(prompt);
            const response = await result.response;
            const translatedText = response.text().trim();
            const usage = response.usageMetadata;
            if (usage) tokenLogger.log({ method: 'agent.text.translate', model: targetModel, provider: 'gemini', inputTokens: usage.promptTokenCount || 0, outputTokens: usage.candidatesTokenCount || 0 });
            return {
                success: true,
                translatedText,
                sourceLang: sourceLang || 'auto',
                metadata: { provider: 'gemini', model: targetModel }
            };
        } catch (error) {
            logger.error('[Gemini] Translation Error:', error);
            throw error;
        }
    }

    async classifyImage({ image, categories, lang, model }) {
        logger.info('[Gemini] Classifying image against category list...');
        const targetModel = model || 'gemini-2.5-flash';
        const targetLang = lang || this.config.language || 'zh';

        const catLines = (categories || [])
            .map(c => `${c.id}: ${c.label?.[targetLang] || c.label?.zh || c.id}`)
            .join('\n');

        const prompt = targetLang === 'zh'
            ? `你是商品分类专家。请根据图片中的商品，从下列系统分类中选出最匹配的一个。\n\n分类列表：\n${catLines}\n\n只返回 JSON，格式：{"categoryId":"...","categoryName":"...","confidence":0.0-1.0,"reason":"一句话说明"}`
            : `You are a product classification expert. Choose the best matching category from the list.\n\nCategories:\n${catLines}\n\nReturn JSON only: {"categoryId":"...","categoryName":"...","confidence":0.0-1.0,"reason":"one sentence"}`;

        try {
            const genModel = this.genAI.getGenerativeModel({ model: targetModel });
            const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
            const result = await genModel.generateContent([
                prompt,
                { inlineData: { data: base64Data, mimeType: 'image/jpeg' } },
            ]);
            const usage = result.response.usageMetadata;
            if (usage) tokenLogger.log({ method: 'agent.image.classify', model: targetModel, provider: 'gemini', inputTokens: usage.promptTokenCount, outputTokens: usage.candidatesTokenCount });
            const text = result.response.text();
            const match = text.match(/\{[\s\S]*\}/);
            if (match) {
                const res = JSON.parse(match[0]);
                return { success: true, ...res, metadata: { provider: 'gemini', model: targetModel } };
            }
            throw new Error('No JSON in Gemini response');
        } catch (error) {
            logger.error('[Gemini] classifyImage Error:', error.message);
            return { success: false, error: error.message, metadata: { provider: 'gemini', model: targetModel } };
        }
    }

    async psImage({ image, prompt, model }) {
        logger.info('[Gemini] PS Image (background removal)...');
        const targetModel = model || 'gemini-2.5-flash-image';
        try {
            const genModel = this.genAI.getGenerativeModel({
                model: targetModel,
                generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
            });

            const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
            const result = await genModel.generateContent([
                prompt || '去除图片背景，替换为纯白色背景，保持商品完整清晰，输出适合电商平台的主图。',
                { inlineData: { data: base64Data, mimeType: 'image/jpeg' } },
            ]);

            const usage = result.response.usageMetadata;
            const usageData = usage ? {
                inputTokens: usage.promptTokenCount,
                outputTokens: usage.candidatesTokenCount,
                totalTokens: usage.totalTokenCount
            } : null;

            if (usage) {
                logger.info(`[Gemini] psImage tokens — input: ${usage.promptTokenCount}, output: ${usage.candidatesTokenCount}, total: ${usage.totalTokenCount}`);
                tokenLogger.log({ method: 'agent.image.ps', model: targetModel, provider: 'gemini', inputTokens: usage.promptTokenCount, outputTokens: usage.candidatesTokenCount, hasImageOutput: true });
            }

            const parts = result.response.candidates?.[0]?.content?.parts ?? [];
            for (const part of parts) {
                if (part.inlineData?.data) {
                    const mimeType = part.inlineData.mimeType || 'image/png';
                    const rawData = part.inlineData.data;

                    // Post-process with sharp: trim → pad → sharpen → JPEG
                    try {
                        const sharp = require('sharp');
                        const buf = Buffer.from(rawData, 'base64');

                        // Step 1: trim background edges (detects corner pixel color)
                        const trimmed = await sharp(buf)
                            .trim({ threshold: 15 })
                            .toBuffer();

                        // Step 2: calc 8% padding from trimmed dimensions
                        const { width, height } = await sharp(trimmed).metadata();
                        const pad = Math.round(Math.max(width, height) * 0.08);
                        const bg = { r: 245, g: 245, b: 245 };

                        // Step 3: add even padding + resize to 800×800 + sharpen + JPEG
                        const finalBuf = await sharp(trimmed)
                            .extend({ top: pad, bottom: pad, left: pad, right: pad, background: bg })
                            .resize(800, 800, { fit: 'contain', background: bg })
                            .sharpen({ sigma: 0.8, m1: 1.5, m2: 2.0 })
                            .jpeg({ quality: 88 })
                            .toBuffer();

                        logger.info(`[Gemini] psImage post-processed: trim+pad(${pad}px)+sharpen → 800×800 JPEG`);
                        return {
                            success: true,
                            image: finalBuf.toString('base64'),
                            mimeType: 'image/jpeg',
                            metadata: { provider: 'gemini', model: targetModel, usage: usageData },
                        };
                    } catch (sharpErr) {
                        logger.warn('[Gemini] psImage sharp post-processing failed, returning raw:', sharpErr.message);
                        return {
                            success: true,
                            image: rawData,
                            mimeType,
                            metadata: { provider: 'gemini', model: targetModel, usage: usageData },
                        };
                    }
                }
            }
            throw new Error('No image in Gemini response');
        } catch (error) {
            logger.error('[Gemini] psImage Error:', error.message);
            throw error;
        }
    }
    async classifyImage({ image, categories, lang, model }) {
        logger.info('[Gemini] Classifying image...');
        const targetModel = model || "gemini-2.5-flash";
        const targetLang = lang || this.config.language || 'zh';

        const catLines = (categories || [])
            .map(c => `${c.id || c.code}: ${c.label?.[targetLang] || c.label?.zh || c.name || c.id}`)
            .join('\n');

        const systemPrompt = targetLang === 'zh'
            ? `你是商品分类专家。请根据图片中的商品，从下列系统分类中选出最匹配的一个。\n\n分类列表：\n${catLines}\n\n只返回 JSON，格式：{"categoryId":"...","categoryName":"...","confidence":0.0-1.0,"reason":"一句话说明"}`
            : `You are a product classification expert. Based on the product in the image, choose the best matching category from the list below.\n\nCategory list:\n${catLines}\n\nReturn JSON only: {"categoryId":"...","categoryName":"...","confidence":0.0-1.0,"reason":"one sentence"}`;

        try {
            const genModel = this.genAI.getGenerativeModel({ 
                model: targetModel
            }, { apiVersion: 'v1' });

            const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
            
            const result = await genModel.generateContent([
                { text: systemPrompt },
                {
                    inlineData: {
                        data: base64Data,
                        mimeType: "image/jpeg"
                    }
                },
                { text: targetLang === 'zh' ? '请分类这张图片。' : 'Please classify this image.' }
            ]);

            const response = await result.response;
            const text = response.text();
            
            const usage = response.usageMetadata;
            if (usage) tokenLogger.log({ method: 'agent.image.classify', model: targetModel, provider: 'gemini', inputTokens: usage.promptTokenCount || 0, outputTokens: usage.candidatesTokenCount || 0 });

            const match = text.match(/\{[\s\S]*\}/);
            if (match) {
                const res = JSON.parse(match[0]);
                return {
                    success: true,
                    categoryId: res.categoryId,
                    categoryName: res.categoryName,
                    confidence: res.confidence,
                    reason: res.reason,
                    metadata: { provider: 'gemini', model: targetModel }
                };
            }
            throw new Error('No JSON found in response');
        } catch (error) {
            logger.error('[Gemini] classifyImage Error:', error.message);
            return { success: false, error: error.message, metadata: { provider: 'gemini', model: targetModel } };
        }
    }


    async generateImage({ prompt, model }) {
        logger.info('[Gemini] Generating image from text prompt...');
        const targetModel = model || 'gemini-2.5-flash-image';
        try {
            const genModel = this.genAI.getGenerativeModel({
                model: targetModel,
                generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
            });

            const result = await genModel.generateContent(prompt);

            const usage = result.response.usageMetadata;
            if (usage) {
                tokenLogger.log({ method: 'agent.image.generate', model: targetModel, provider: 'gemini', inputTokens: usage.promptTokenCount, outputTokens: usage.candidatesTokenCount, hasImageOutput: true });
            }

            const parts = result.response.candidates?.[0]?.content?.parts ?? [];
            for (const part of parts) {
                if (part.inlineData?.data) {
                    const mimeType = part.inlineData.mimeType || 'image/png';
                    return {
                        success: true,
                        image: part.inlineData.data,
                        mimeType,
                        metadata: { provider: 'gemini', model: targetModel },
                    };
                }
            }
            throw new Error('No image in Gemini response');
        } catch (error) {
            logger.error('[Gemini] generateImage Error:', error.message);
            throw error;
        }
    }

    async suggestCategoryAttrs({ categoryPath, model }) {
        logger.info('[Gemini] Suggesting category attributes for:', categoryPath.join(' > '));
        const PromptBuilder = require('../logic/prompt');
        const { system, user } = PromptBuilder.buildCategoryAttrSuggest(categoryPath);
        const targetModel = model || 'gemini-pro';
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(this.config.geminiApiKey);
        const genModel = genAI.getGenerativeModel({ model: targetModel });
        const result = await genModel.generateContent(`${system}\n\n${user}`);
        const text = result.response.text().trim().replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        const attrs = JSON.parse(text);
        if (!Array.isArray(attrs)) throw new Error('AI 返回格式错误');
        return attrs;
    }

    async getEmbedding({ text, image, model }) {
        logger.info('[Gemini] Getting Multimodal Embedding...');
        const targetModel = model || "gemini-embedding-2";
        try {
            const genModel = this.genAI.getGenerativeModel({ model: targetModel }, { apiVersion: 'v1beta' });
            
            const parts = [];
            if (text) parts.push({ text });
            if (image) {
                const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
                parts.push({
                    inlineData: {
                        data: base64Data,
                        mimeType: "image/jpeg",
                    },
                });
            }

            const result = await genModel.embedContent({ content: { parts } });
            const embedding = result.embedding.values;

            tokenLogger.log({ 
                method: 'agent.tensor.embedding', 
                model: targetModel, 
                provider: 'gemini', 
                inputTokens: 0, 
                outputTokens: 0 
            });

            return {
                success: true,
                embedding,
                metadata: { provider: 'gemini', model: targetModel }
            };
        } catch (error) {
            logger.error('[Gemini] Embedding Error:', error);
            throw error;
        }
    }
}


module.exports = GeminiProvider;

