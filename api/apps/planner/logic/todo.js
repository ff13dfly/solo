const createEntity = require('../../../library/entity');
const jsonrpc = require('../../../library/jsonrpc');

module.exports = (redis, context) => {
    const getEntity = (user) => {
        const uid = (typeof user === 'string' ? user : user?.uid) || 'anonymous';
        return createEntity(redis, {
            serviceName: `PLANNER:U:${uid}`,
            entityName: 'TODO',
            idLength: 8,
            softDelete: true
        });
    };

    return {
        create: (params, user) => getEntity(user).create(params),
        get: (params, user) => getEntity(user).get(params),
        update: (params, user) => getEntity(user).update(params),
        delete: (params, user) => getEntity(user).delete(params),
        list: (params, user) => getEntity(user).list(params),

        /**
         * Bulk Sync for Todos
         */
        sync: async ({ todos }, user) => {
            if (!Array.isArray(todos)) throw jsonrpc.INVALID_PARAMS('todos array required');
            const entity = getEntity(user);
            const uid = (typeof user === 'string' ? user : user?.uid) || 'anonymous';
            const baseKey = `PLANNER:U:${uid}:TODO:`;
            const indexKey = `PLANNER:U:${uid}:TODO:INDEX`;

            const results = [];
            const idMap = {};

            for (const todo of todos) {
                try {
                    const isLocal = !todo.id || todo.id.toString().startsWith('local-');

                    if (isLocal) {
                        const { id: oldId, ...itemData } = todo;
                        const newTodo = await entity.create(itemData);
                        idMap[oldId] = newTodo.id;
                        results.push({ id: newTodo.id, oldId, action: 'create', success: true });
                    } else {
                        const exists = await redis.exists(`${baseKey}${todo.id}`);
                        if (exists) {
                            await entity.update(todo);
                            results.push({ id: todo.id, action: 'update', success: true });
                        } else {
                            // Restore if deleted but sent from client (or force create)
                            await redis.set(`${baseKey}${todo.id}`, JSON.stringify({
                                ...todo,
                                status: 'ACTIVE',
                                updatedAt: Date.now()
                            }));
                            await redis.sAdd(indexKey, todo.id.toString());
                            results.push({ id: todo.id, action: 'restore', success: true });
                        }
                    }
                } catch (err) {
                    results.push({ id: todo.id, error: err.message });
                }
            }

            // Cleanup
            try {
                const serverIds = await redis.sMembers(indexKey);
                const clientIds = new Set(todos.map(t => t.id));
                Object.values(idMap).forEach(v => clientIds.add(v));

                for (const sId of serverIds) {
                    if (!clientIds.has(sId)) {
                        await entity.delete({ id: sId });
                    }
                }
            } catch (err) {
                console.error('[Planner] Todo cleanup failed:', err);
            }

            return { success: true, count: todos.length, idMap };
        },

        linkAgenda: async (todoId, agendaId, user) => {
            const entity = getEntity(user);
            const todo = await entity.get({ id: todoId });
            const relatedAgendas = todo.relatedAgendas || [];
            if (!relatedAgendas.includes(agendaId)) {
                relatedAgendas.push(agendaId);
                await entity.update({ id: todoId, relatedAgendas });
            }
        }
    };
};
