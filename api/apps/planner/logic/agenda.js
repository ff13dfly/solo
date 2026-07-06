const createEntity = require('../../../library/entity');
const jsonrpc = require('../../../library/jsonrpc');

module.exports = (redis, context) => {
    const { todo } = context;

    /**
     * Internal helper to get a user-isolated entity factory.
     */
    const getEntity = (user) => {
        const uid = (typeof user === 'string' ? user : user?.uid) || 'anonymous';
        return createEntity(redis, {
            serviceName: `PLANNER:U:${uid}`,
            entityName: 'AGENDA',
            idLength: 8,
            softDelete: false
        });
    };

    /**
     * Parses the title/content for #todoId tags and links them.
     */
    const syncTodoLink = async (agendaId, title = '', content = '', user) => {
        const fullText = `${title} ${content}`;
        const todoMatch = fullText.match(/#([a-zA-Z0-9]{8})/);
        if (todoMatch && todo) {
            const todoId = todoMatch[1];
            try {
                await todo.linkAgenda(todoId, agendaId, user);
                return todoId;
            } catch (err) {
                const { logger } = context;
                if (logger) logger.warn(`Failed to link todo ${todoId} to agenda ${agendaId}: ${err.message}`);
            }
        }
        return null;
    };

    return {
        create: async (params, user) => {
            const entity = getEntity(user);
            const result = await entity.create(params);
            const todoId = await syncTodoLink(result.id, params.title, params.content, user);
            if (todoId) {
                await entity.update({ id: result.id, todoId });
            }
            return result;
        },

        get: (params, user) => getEntity(user).get(params),
        update: async (params, user) => {
            const entity = getEntity(user);
            const result = await entity.update(params);
            if (params.title !== undefined || params.content !== undefined) {
                const current = await entity.get({ id: params.id });
                const todoId = await syncTodoLink(params.id, current.title, current.content, user);
                if (todoId) {
                    await entity.update({ id: params.id, todoId });
                }
            }
            return result;
        },
        delete: (params, user) => getEntity(user).delete(params),
        list: (params, user) => getEntity(user).list(params),

        /**
         * Bulk Sync: Reconciles the local event list with the server state.
         * Isolated by User ID.
         */
        sync: async ({ events }, user) => {
            if (!Array.isArray(events)) throw jsonrpc.INVALID_PARAMS('events array required');
            const entity = getEntity(user);
            const uid = (typeof user === 'string' ? user : user?.uid) || 'anonymous';
            const baseKey = `PLANNER:U:${uid}:AGENDA:`;
            const indexKey = `PLANNER:U:${uid}:AGENDA:INDEX`;

            const results = [];
            const idMap = {};

            for (const event of events) {
                try {
                    const isLocal = !event.id || event.id.toString().startsWith('local-');

                    if (isLocal) {
                        // Create proper server ID
                        const { id: oldId, ...itemData } = event;
                        const newEvent = await entity.create(itemData);
                        idMap[oldId] = newEvent.id;
                        results.push({ id: newEvent.id, oldId, action: 'create', success: true });
                    } else {
                        // Update
                        const exists = await redis.exists(`${baseKey}${event.id}`);
                        if (exists) {
                            await entity.update(event);
                            results.push({ id: event.id, action: 'update', success: true });
                        } else {
                            // If it's not local but doesn't exist, we force create it (might happen if cache cleared but sync pending)
                            await redis.set(`${baseKey}${event.id}`, JSON.stringify({
                                ...event,
                                status: 'ACTIVE',
                                updatedAt: Date.now()
                            }));
                            await redis.sAdd(indexKey, event.id.toString());
                            results.push({ id: event.id, action: 'restore', success: true });
                        }
                    }
                } catch (err) {
                    console.error('[Planner] Sync failed for item:', event.id, err);
                    results.push({ id: event.id, error: err.message });
                }
            }

            // Cleanup deletions: Only if the list is comprehensive
            // (Client usually sends the full list of active events)
            try {
                const serverIds = await redis.sMembers(indexKey);
                const clientIds = new Set(events.map(e => e.id));

                // Also account for the newly mapped IDs
                Object.values(idMap).forEach(v => clientIds.add(v));

                for (const sId of serverIds) {
                    if (!clientIds.has(sId)) {
                        await entity.delete({ id: sId });
                    }
                }
            } catch (err) {
                console.error('[Planner] Cleanup failed during sync:', err);
            }

            return { success: true, count: events.length, idMap };
        }
    };
};
