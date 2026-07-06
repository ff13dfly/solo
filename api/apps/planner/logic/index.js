const createAgendaLogic = require('./agenda');
const createTodoLogic = require('./todo');

/**
 * Logic Factory
 * 
 * @why Orchestrates the initialization of all business logic modules. 
 */
module.exports = (redis, context) => {
    const todo = createTodoLogic(redis, context);
    const agenda = createAgendaLogic(redis, { ...context, todo });

    return {
        todo,
        agenda
    };
};
