const createAssetLogic = require('./asset');
const { createStorageProvider } = require('../oss');

/**
 * @why Builds the storage provider from config.storage (STORAGE_PROVIDER=local|aliyun)
 *      and injects it into the asset logic. A pre-built provider can be passed via
 *      context.store (used by tests/simulation that boot an in-process local server).
 */
module.exports = (redis, context) => {
    const { config } = context;
    const store = context.store || createStorageProvider(config.storage || {});
    return {
        asset: createAssetLogic(redis, config, store),
        store,
    };
};
