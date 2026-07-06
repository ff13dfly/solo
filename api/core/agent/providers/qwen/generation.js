const { MODEL_MATTING, MODEL_BG_GEN, MATTING_API, BG_GEN_API } = require('./constants');
const { createLogger } = require('../../../../library/logger');

const logger = createLogger('agent');

/**
 * Qwen Generation Capability
 * @why Implements AIGC (Image Matting, Background Gen) via Alibaba DashScope.
 */
module.exports = {
    async processImage({ image, scene = 'studio', model }) {
        logger.info('[Qwen] Processing image for ecommerce...');
        
        // Step 1: Image Matting (抠图)
        // Note: DashScope's matting can be sync or async.
        // For now we use the main generation API which often handles basic matting internally 
        // if we provide the right parameters.
        
        logger.info('[Qwen] Calling DashScope Background Generation...');
        const bgRes = await this._callApi(BG_GEN_API, {
            input: {
                main_image_url: image,
                prompt: `professional ecommerce ${scene} background, simple white or studio setup, high resolution, soft lighting`
            },
            parameters: {
                n: 1,
                ref_prompt: scene
            }
        }, MODEL_BG_GEN || 'background-generation');

        if (bgRes.output && bgRes.output.results) {
            return {
                success: true,
                url: bgRes.output.results[0].url,
                metadata: { provider: 'qwen', request_id: bgRes.request_id }
            };
        }

        throw new Error(bgRes.message || 'Image generation failed');
    }
};
