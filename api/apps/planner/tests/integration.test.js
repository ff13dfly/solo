const redis = require('redis');
const config = require('../config');
const createLogic = require('../logic');

async function testLinking() {
    const client = redis.createClient({ url: config.redisUrl });
    await client.connect();

    const Methods = createLogic(client, { serviceName: 'planner' });

    console.log('1. Creating a Todo...');
    const todo = await Methods.todo.create({
        userId: 'test_user',
        name: 'Test Project',
        content: '# Mission Start'
    });
    console.log('Created Todo:', todo.id);

    console.log('2. Creating an Agenda with #tag...');
    const agenda = await Methods.agenda.create({
        userId: 'test_user',
        title: `Work on #${todo.id} today`,
        startTime: Date.now(),
        endTime: Date.now() + 3600000
    });
    console.log('Created Agenda:', agenda.id);

    console.log('3. Verifying Link in Todo...');
    const updatedTodo = await Methods.todo.get({ id: todo.id });
    console.log('Todo relatedAgendas:', updatedTodo.relatedAgendas);

    if (updatedTodo.relatedAgendas && updatedTodo.relatedAgendas.includes(agenda.id)) {
        console.log('✅ Success: Agenda linked to Todo!');
    } else {
        console.log('❌ Failure: Link not found.');
    }

    await client.quit();
}

testLinking().catch(err => {
    console.error(err);
    process.exit(1);
});
