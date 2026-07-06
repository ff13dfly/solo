/**
 * Mock Data Seeder for Orchestrator Service
 * Seeds sample workflows to Redis for manual testing
 * 
 * Usage: node api/orchestrator/tests/utils/mock_data.js
 */

const redis = require('redis');

const KEY_PREFIX = 'ORCHESTRATOR:WORKFLOW:';

const SAMPLE_WORKFLOWS = [
    {
        id: 'meeting_setup_v1',
        category: 'Collaboration',
        priority: 80,
        name: 'Setup Project Meeting',
        desc: 'Creates a calendar event, books a room, and notifies core team.',
        tags: ['meeting', 'calendar', 'notification'],
        examples: ['Book a meeting', 'Schedule a sync', 'Set up a call'],
        negative: ['Cancel meeting', 'Delete event'],
        required_inputs: ['roomId', 'startTime'],
        optional_inputs: ['title', 'duration'],
        synonyms: { roomId: ['meeting room', 'conference room'] },
        defaults: { duration: 60, platform: 'Zoom' },
        steps: [
            {
                id: 'book_room',
                service: 'asset',
                method: 'asset.unit.reserve',
                params: {
                    unitId: '$input.roomId',
                    startTime: '$input.startTime',
                    duration: '$config.duration'
                }
            },
            {
                id: 'create_event',
                service: 'calendar',
                method: 'calendar.event.create',
                params: {
                    title: '$input.title',
                    location: '$step.book_room.result.locationName'
                }
            }
        ],
        status: 'ACTIVE',
        createdAt: Date.now(),
        updatedAt: Date.now()
    },
    {
        id: 'customer_onboard_v1',
        category: 'CRM',
        priority: 90,
        name: 'Customer Onboarding',
        desc: 'Creates customer record, assigns sales rep, and sends welcome email.',
        tags: ['customer', 'onboarding', 'crm'],
        examples: ['Add new customer', 'Onboard client', 'Register customer'],
        negative: ['Delete customer', 'Remove client'],
        required_inputs: ['customerName', 'email'],
        optional_inputs: ['phone', 'company'],
        synonyms: {},
        defaults: { tier: 'standard' },
        steps: [
            {
                id: 'create_customer',
                service: 'crm',
                method: 'crm.customer.create',
                params: {
                    name: '$input.customerName',
                    email: '$input.email',
                    phone: '$input.phone',
                    company: '$input.company'
                }
            },
            {
                id: 'assign_rep',
                service: 'crm',
                method: 'crm.customer.assign',
                params: {
                    customerId: '$step.create_customer.result.id'
                }
            },
            {
                id: 'send_greet',
                service: 'notification',
                method: 'notification.email.send',
                params: {
                    to: '$input.email',
                    template: 'welcome'
                },
                ignore_error: true
            }
        ],
        status: 'ACTIVE',
        createdAt: Date.now(),
        updatedAt: Date.now()
    },
    {
        id: 'inventory_check_v1',
        category: 'Asset',
        priority: 70,
        name: 'Inventory Stock Check',
        desc: 'Checks stock levels and triggers reorder if below threshold.',
        tags: ['inventory', 'stock', 'reorder'],
        examples: ['Check inventory', 'Stock level check'],
        negative: ['Add inventory'],
        required_inputs: ['warehouseId'],
        optional_inputs: ['categoryFilter'],
        synonyms: {},
        defaults: { threshold: 10 },
        steps: [
            {
                id: 'get_stock',
                service: 'asset',
                method: 'asset.stuff.list',
                params: {
                    warehouseId: '$input.warehouseId',
                    category: '$input.categoryFilter'
                }
            },
            {
                id: 'check_status',
                service: 'asset',
                method: 'asset.stuff.checkLevels',
                params: {
                    items: '$step.get_stock.result.items',
                    threshold: '$config.threshold'
                },
                condition: '$step.get_stock.result.items.length > 0'
            }
        ],

        status: 'ACTIVE',
        createdAt: Date.now(),
        updatedAt: Date.now()
    }
];

async function seedData() {
    const client = redis.createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379'
    });

    await client.connect();
    console.log('Redis connected');

    let count = 0;
    for (const workflow of SAMPLE_WORKFLOWS) {
        const key = `${KEY_PREFIX}${workflow.id}`;
        await client.json.set(key, '$', workflow);
        console.log(`Seeded: ${workflow.id}`);
        count++;
    }

    console.log(`\n✅ Seeded ${count} workflows to Redis`);
    
    await client.quit();
}

seedData().catch(console.error);
