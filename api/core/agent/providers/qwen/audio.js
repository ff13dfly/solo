const { MODEL_AUDIO, VL_API } = require('./constants');
const tokenLogger = require('../../lib/tokenLogger');
const { createLogger } = require('../../../../library/logger');
const logger = createLogger('agent');

module.exports = {
    /**
     * transcribeAudio
     * @why Uses Qwen-Audio model to transcribe speech to text.
     */
    async transcribeAudio({ audio, model, mimeType }) {
        logger.info('[Qwen] Transcribing Audio...');
        const targetModel = model || MODEL_AUDIO;

        // Qwen-Audio expects the same multimodal format as Qwen-VL
        // The audio should be passed as a data URI if in base64
        const audioUrl = audio.startsWith('http') ? audio : `data:${mimeType || 'audio/m4a'};base64,${audio}`;

        const body = {
            input: {
                messages: [
                    {
                        role: 'user',
                        content: [
                            { audio: audioUrl },
                            { text: '请将这段语音转录为文字。' }
                        ]
                    }
                ]
            },
            parameters: {
                result_format: 'message'
            }
        };

        try {
            const response = await this._callApi(VL_API, body, targetModel);
            
            const text = response.output?.choices?.[0]?.message?.content?.[0]?.text || '';
            
            if (response.usage) {
                tokenLogger.log({ 
                    method: 'agent.audio.transcribe', 
                    model: targetModel, 
                    provider: 'qwen', 
                    inputTokens: response.usage.input_tokens || 0, 
                    outputTokens: response.usage.output_tokens || 0 
                });
            }

            return {
                success: true,
                text,
                metadata: { 
                    provider: 'qwen', 
                    model: targetModel, 
                    usage: response.usage 
                }
            };
        } catch (error) {
            logger.error('[Qwen] Audio Transcription Error:', error.message);
            throw error;
        }
    }
};
