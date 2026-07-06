const createEntity = require('../../library/entity');
const { normalizeString } = require('../../library/validate');

/**
 * Item Logic (Sample Service)
 * @why Demonstrates how to use the shared Entity Factory to handle CRUD.
 */
module.exports = (redis, config) => {
    const itemEntity = createEntity(redis, {
        serviceName: config.serviceName,
        entityName: 'item',
        idLength: config.idLengths.item,
        softDelete: true,
        searchFields: ['name', 'description']
    });

    return {
        // The validation split in action: the Router already enforced the DECLARED schema
        // (type/length/pattern from handlers/introspection.js) before this runs. Here the
        // service does the SEMANTIC touch the Router can't — normalize human input (NFC + trim)
        // so 'widget ' and 'widget' don't become two distinct records. For richer per-service
        // rules call library/validate.checkString(value, rule) and throw a jsonrpc error.
        create:    (params) => itemEntity.create({ ...params, name: normalizeString(params.name) }),
        get:       (params) => itemEntity.get(params),
        update:    (params) => itemEntity.update(params),
        delete:    (params) => itemEntity.delete(params),
        restore:   (params) => itemEntity.restore(params),
        setStatus: (params) => itemEntity.status(params),
        list:      (params) => itemEntity.list(params),
        purgeable: (params) => itemEntity.purgeable(params),
        destroy:   (params) => itemEntity.destroy(params)
    };
};
