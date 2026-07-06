module.exports = {
    ...require('../../../library/jsonrpc'),
    ASSET_NOT_FOUND: () => ({ code: -32002, message: 'Asset not found' }),
    UPLOAD_FAILED:   (msg) => ({ code: -32603, message: msg || 'Upload failed' }),
};
