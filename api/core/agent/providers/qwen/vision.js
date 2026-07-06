const PromptBuilder = require('../../logic/prompt');
const { createLogger } = require('../../../../library/logger');
const { MODEL_VL, VL_API, MODEL_EMBED, EMBED_API } = require('./constants');
const tokenLogger = require('../../lib/tokenLogger');

const logger = createLogger('agent');

module.exports = {
    async extractProductInfo({ images, schema, meta, model }) {
        logger.info('[Qwen] Extracting Product Info (Grouped Strategy)...');
        const targetModel = model || MODEL_VL;
        const lang = this.config.language || 'zh';

        const appearanceGroup = images.filter(img =>
            ['front', 'left', 'right', 'label'].includes(img.meta?.role) || !img.meta?.role
        );
        const technicalGroup = images.filter(img =>
            ['back', 'nameplate', 'specs', 'specs_close'].includes(img.meta?.role)
        );

        if (appearanceGroup.length === 0 && technicalGroup.length > 0) appearanceGroup.push(...technicalGroup);
        if (technicalGroup.length === 0 && appearanceGroup.length > 0) technicalGroup.push(...appearanceGroup);

        const runExtraction = async (groupImages, focus) => {
            if (groupImages.length === 0) return null;
            const prompt = PromptBuilder.buildProductExtraction(lang, schema, meta, focus);
            const content = groupImages.map(img => ({ image: `data:image/jpeg;base64,${img.data}` }));
            content.push({ text: prompt });

            const response = await this._callApi(VL_API, {
                input: { messages: [{ role: 'user', content }] },
                parameters: { result_format: 'message' }
            }, targetModel);

            if (response.output?.choices) {
                const choiceContent = response.output.choices[0].message.content;
                const text = typeof choiceContent === 'string' ? choiceContent : (choiceContent[0].text || '');
                try {
                    const match = text.match(/\{[\s\S]*\}/);
                    if (match) return JSON.parse(match[0]);
                } catch (e) {
                    logger.warn(`[Qwen] Group ${focus} parse failed:`, text.substring(0, 100));
                }
            }
            return null;
        };

        try {
            const [resA, resB] = await Promise.all([
                runExtraction(appearanceGroup, 'appearance'),
                runExtraction(technicalGroup, 'technical')
            ]);

            if (!resA && !resB) throw new Error('Both extraction groups failed to return valid data');

            const finalResults = {};
            const languages = ['zh', 'en', 'ja', 'ko'];

            languages.forEach(l => {
                const dataA = resA?.[l] || {};
                const dataB = resB?.[l] || {};
                finalResults[l] = {};
                const allFields = new Set([...Object.keys(dataA), ...Object.keys(dataB)]);

                allFields.forEach(field => {
                    const valA = dataA[field];
                    const valB = dataB[field];
                    let winner = valA;
                    const isTechField = ['specs', 'sku', 'model'].includes(field.toLowerCase());
                    const isAppField = ['name', 'description', 'title'].includes(field.toLowerCase());

                    if (isTechField && (valB?.confidence || 0) > 0) winner = valB;
                    else if (isAppField && (valA?.confidence || 0) > 0) winner = valA;
                    else if ((valB?.confidence || 0) > (valA?.confidence || 0)) winner = valB;

                    finalResults[l][field] = winner || { value: null, confidence: 0 };
                });
            });

            return {
                success: true,
                data: finalResults,
                metadata: { provider: 'qwen', model: targetModel, strategy: 'grouped', groups: { a: appearanceGroup.length, b: technicalGroup.length } }
            };
        } catch (error) {
            logger.error('[Qwen] Grouped Extraction Failed:', error.message);
            return { success: false, error: `分组提取失败: ${error.message}`, metadata: { provider: 'qwen', model: targetModel } };
        }
    },

    async parseImage({ image, scene, lang, model }) {
        logger.info('[Qwen] Parsing Image...');
        const targetModel = model || MODEL_VL;
        const targetLang = lang || this.config.language || 'zh';
        const prompt = PromptBuilder.buildVision(scene, targetLang);

        try {
            const response = await this._callApi(VL_API, {
                input: {
                    messages: [{
                        role: 'user',
                        content: [
                            { image: image },
                            { text: prompt }
                        ]
                    }]
                }
            }, targetModel);

            if (response.output?.choices) {
                if (response.usage) {
                    tokenLogger.log({ 
                        method: 'agent.image.parse', 
                        model: targetModel, 
                        provider: 'qwen', 
                        inputTokens: response.usage.input_tokens || 0, 
                        outputTokens: response.usage.output_tokens || 0 
                    });
                }
                const content = response.output.choices[0].message.content;
                const text = typeof content === 'string' ? content : (content[0].text || '');
                return { 
                    success: true, 
                    text, 
                    metadata: { 
                        provider: 'qwen', 
                        model: targetModel, 
                        request_id: response.request_id,
                        usage: response.usage ? {
                            inputTokens: response.usage.input_tokens,
                            outputTokens: response.usage.output_tokens,
                            totalTokens: response.usage.input_tokens + response.usage.output_tokens
                        } : null
                    } 
                };
            }
            throw new Error(response.message || 'No output from Qwen VL');
        } catch (error) {
            if (error._isNetwork) { logger.warn('[Qwen] Image Network Error (Will retry):', error.message); throw error; }
            logger.error('[Qwen] Image Error:', error.message);
            return { success: false, error: error.message, metadata: { provider: 'qwen', model: targetModel } };
        }
    },

    async scanLabel({ image, model, prompt: customPrompt }) {
        logger.info('[Qwen] Scanning label...');
        const targetModel = model || MODEL_VL;
        const prompt = customPrompt || '请识别图片中产品标签上的SKU编号（料号/货号/型号）和条形码数值。只返回JSON，格式：{"sku":"...","barcode":"..."}。如果某项找不到，设为null。';

        try {
            const response = await this._callApi(VL_API, {
                input: {
                    messages: [{
                        role: 'user',
                        content: [
                            { image: `data:image/jpeg;base64,${image}` },
                            { text: prompt }
                        ]
                    }]
                },
                parameters: { result_format: 'message' }
            }, targetModel);

            const content = response.output?.choices?.[0]?.message?.content;
            const text = typeof content === 'string' ? content : (Array.isArray(content) ? (content[0]?.text || '') : '');
            if (response.usage) tokenLogger.log({ method: 'agent.label.scan', model: targetModel, provider: 'qwen', inputTokens: response.usage.input_tokens || 0, outputTokens: response.usage.output_tokens || 0 });
            const match = text.match(/\{[\s\S]*\}/);
            if (match) {
                const { sku = null, barcode = null } = JSON.parse(match[0]);
                return { success: true, sku, barcode };
            }
            return { success: true, sku: null, barcode: null };
        } catch (error) {
            if (error._isNetwork) throw error;
            logger.error('[Qwen] scanLabel Error:', error.message);
            return { success: false, error: error.message, sku: null, barcode: null };
        }
    },

    async classifyImage({ image, categories, lang, model }) {
        logger.info('[Qwen] Classifying image against category list...');
        const targetModel = model || MODEL_VL;
        const targetLang = lang || this.config.language || 'zh';

        // Build a compact category list for the prompt (leaf nodes preferred)
        const catLines = (categories || [])
            .map(c => `${c.id}: ${c.label?.[targetLang] || c.label?.zh || c.id}`)
            .join('\n');

        const prompt = targetLang === 'zh'
            ? `你是商品分类专家。请根据图片中的商品，从下列系统分类中选出最匹配的一个。\n\n分类列表：\n${catLines}\n\n只返回 JSON，格式：{"categoryId":"...","categoryName":"...","confidence":0.0-1.0,"reason":"一句话说明"}`
            : `You are a product classification expert. Based on the product in the image, choose the best matching category from the list below.\n\nCategory list:\n${catLines}\n\nReturn JSON only: {"categoryId":"...","categoryName":"...","confidence":0.0-1.0,"reason":"one sentence"}`;

        try {
            const response = await this._callApi(VL_API, {
                input: {
                    messages: [{
                        role: 'user',
                        content: [
                            { image: image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}` },
                            { text: prompt }
                        ]
                    }]
                },
                parameters: { result_format: 'message' }
            }, targetModel);

            if (response.output?.choices) {
                if (response.usage) tokenLogger.log({ method: 'agent.image.classify', model: targetModel, provider: 'qwen', inputTokens: response.usage.input_tokens || 0, outputTokens: response.usage.output_tokens || 0 });
                const content = response.output.choices[0].message.content;
                const text = typeof content === 'string' ? content : (content[0]?.text || '');
                const match = text.match(/\{[\s\S]*\}/);
                if (match) {
                    const result = JSON.parse(match[0]);
                    return { success: true, ...result, metadata: { provider: 'qwen', model: targetModel } };
                }
                throw new Error('No JSON in response');
            }
            throw new Error(response.message || 'No output from Qwen VL');
        } catch (error) {
            if (error._isNetwork) throw error;
            logger.error('[Qwen] classifyImage Error:', error.message);
            return { success: false, error: error.message, metadata: { provider: 'qwen', model: targetModel } };
        }
    },

    async psImage({ image, prompt, model }) {
        logger.info('[Qwen/Wanxiang] PS Image (background erase)...');
        const { WANX_EDIT_API, MODEL_WANX_EDIT } = require('./constants');
        const targetModel = model || MODEL_WANX_EDIT;

        try {
            const dataUri = image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;

            // Step 1: Submit async task
            const submitRes = await this._callApi(WANX_EDIT_API, {
                input: {
                    function: 'erase-background',
                    image: dataUri,
                    ...(prompt ? { prompt } : {}),
                },
                parameters: { n: 1 },
            }, targetModel, { 'X-DashScope-Async': 'enable' });

            const taskId = submitRes.output?.task_id;
            if (!taskId) throw new Error(submitRes.message || 'No task_id returned by Wanxiang');
            logger.info(`[Qwen/Wanxiang] Task submitted: ${taskId}`);

            // Step 2: Poll until done
            const result = await this._pollTask(taskId);
            const url = result.output?.results?.[0]?.url;
            if (!url) throw new Error('No output URL in Wanxiang result');

            return {
                success: true,
                url,          // temporary CDN URL (valid ~24h)
                metadata: { provider: 'qwen/wanxiang', model: targetModel, task_id: taskId }
            };
        } catch (error) {
            if (error._isNetwork) throw error;
            logger.error('[Qwen/Wanxiang] psImage Error:', error.message);
            throw error;
        }
    },

    async getMultimodalEmbedding({ image, text, model }) {
        logger.info('[Qwen] Getting Multimodal Embedding...');
        const targetModel = model || MODEL_EMBED;
        const contents = [];
        
        if (image) {
            const dataUri = image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;
            contents.push({ image: dataUri });
        }
        if (text) {
            contents.push({ text });
        }

        try {
            const response = await this._callApi(EMBED_API, {
                input: { contents }
            }, targetModel);

            const embedding = response.output?.embeddings?.[0]?.embedding;
            if (!embedding) throw new Error(response.message || 'No embedding returned by Qwen');

            if (response.usage) {
                tokenLogger.log({ 
                    method: 'agent.tensor.embedding', 
                    model: targetModel, 
                    provider: 'qwen', 
                    inputTokens: response.usage.input_tokens || 0, 
                    outputTokens: 0 // Embeddings usually have 0 output tokens
                });
            }

            return {
                success: true,
                embedding,
                metadata: { 
                    provider: 'qwen', 
                    model: targetModel, 
                    request_id: response.request_id,
                    usage: response.usage ? {
                        inputTokens: response.usage.input_tokens,
                        totalTokens: response.usage.input_tokens
                    } : null
                }
            };
        } catch (error) {
            logger.error('[Qwen] Embedding Error:', error.message);
            throw error;
        }
    }
};
