module.exports = {
    DASHSCOPE_BASE_URL: 'dashscope.aliyuncs.com',
    MODEL_CHAT: 'qwen-turbo',
    MODEL_VL: 'qwen-vl-plus',
    MODEL_AUDIO: 'qwen-audio-turbo',
    MODEL_BG_GEN: 'background-generation',
    // 万相 (Wanxiang) image editing — async task API
    MODEL_WANX_EDIT: 'wanx2.1-imageedit',
    MODEL_EMBED: 'multimodal-embedding-v1',
    TEXT_API: '/api/v1/services/aigc/text-generation/generation',
    VL_API: '/api/v1/services/aigc/multimodal-generation/generation',
    BG_GEN_API: '/api/v1/services/aigc/background-generation/generation',
    WANX_EDIT_API: '/api/v1/services/aigc/image2image/image-synthesis',
    EMBED_API: '/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding',
    TASK_QUERY_API: '/api/v1/tasks',  // GET /api/v1/tasks/{task_id}
};
