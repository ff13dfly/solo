require('dotenv').config();
const pkg = require('./package.json');
const { portFor, urlFor } = require('../library/ports');

module.exports = {
    // portFor(name, fallback) resolves: process.env.PORT > global.__SOLO_PORTS__ > fallback.
    // For private apps started by scaffold/run.sh, PORT is injected per service.
    port: portFor('sample', 8999),
    debug: process.env.DEBUG === 'true',
    serviceName: process.env.SERVICE_NAME || 'sample',
    version: pkg.version,
    pageSize: 20,
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6699',
    routerUrl: process.env.ROUTER_URL || urlFor('router', 8600),
    routerPublicKey: process.env.ROUTER_PUBLIC_KEY || '8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji',

    // ID Length Configuration (Config over Hardcoding)
    // @why Defines the length for different entity IDs based on expected scale.
    idLengths: {
        item: 8,      // Standard items (58^8 combinations)
        category: 6   // Short code for categories
    },


    // AI 语义描述 (用于 Agent 意图识别)
    // 参考 docs/ai_format_protocol.md
    description: {
        en: {
            main: [
                "sample service for demonstration purposes",
                "use this as a template for new services",
                "do NOT use in production"
            ],
            methods: {
                "sample.category.create": [
                    "create a new category definition",
                    "reserves globally unique key in Router"
                ],
                "sample.category.delete": [
                    "soft delete a category",
                    "marks status as DELETED in Router"
                ],
                "sample.category.update": ["update category name or metadata"],
                "sample.category.get": ["get category details"],
                "sample.category.list": [
                    "list all categories managed by this service"
                ],
                "sample.category.item.add": [
                    "add item to category"
                ],
                "sample.category.item.get": ["get a single category item by id"],
                "sample.category.item.update": ["update category item"],
                "sample.category.item.remove": ["remove item from category"],
                "sample.index.rebuild": ["rebuild RediSearch index for this service"],
                "sample.index.schemas": ["get current index schema definitions"],
                "sample.item.create": ["create a new demonstration item entity"],
                "sample.item.get": ["retrieve a demonstration item by ID"],
                "sample.item.update": ["update an existing demonstration item"],
                "sample.item.delete": ["permanently remove a demonstration item"],
                "sample.item.list": ["list all demonstration items"],
                "sample.item.restore": ["restore a soft-deleted item"],
                "sample.item.status": ["update the status of an item"],
                "sample.item.purgeable": ["check if an item can be permanently destroyed"],
                "sample.item.destroy": ["permanently destroy a soft-deleted item"],

                // --- Top-level System Methods ---
                "ping": ["service health check"],
                "methods": ["get service method list"],
                "entities": ["get entity definitions (schema)"]
            }
        },
        zh: {
            main: [
                "示例服务，仅供演示和模板参考",
                "请勿在生产环境中使用"
            ],
            methods: {
                "sample.category.create": [
                    "创建新的分类定义",
                    "在 Router 中预留全局唯一 Key"
                ],
                "sample.category.delete": [
                    "软删除分类",
                    "在 Router 中标记状态为 DELETED"
                ],
                "sample.category.update": ["更新分类名称或元数据"],
                "sample.category.get": ["获取分类详情"],
                "sample.category.list": [
                    "列出该服务管理的所有分类"
                ],
                "sample.category.item.add": [
                    "向分类树/列表中添加新项"
                ],
                "sample.category.item.get": ["按 id 获取单个分类项"],
                "sample.category.item.update": ["更新分类项"],
                "sample.category.item.remove": ["从分类中移除项"],
                "sample.index.rebuild": ["重建该服务的 RediSearch 索引"],
                "sample.index.schemas": ["获取当前索引 Schema 定义"],
                "sample.item.create": ["创建新的演示项目实体"],
                "sample.item.get": ["根据 ID 检索演示项目"],
                "sample.item.update": ["更新现有的演示项目"],
                "sample.item.delete": ["永久删除演示项目"],
                "sample.item.list": ["列出所有演示项目"],
                "sample.item.restore": ["恢复已软删除的项目"],
                "sample.item.status": ["更新项目状态"],
                "sample.item.purgeable": ["检查项目是否可被永久销毁"],
                "sample.item.destroy": ["永久销毁已软删除的项目"],

                // --- 顶级系统方法 ---
                "ping": ["服务健康检查"],
                "methods": ["获取服务方法列表"],
                "entities": ["获取实体定义 (Schema)"]
            }
        }
    },

    // RediSearch Index Definitions (Config over Hardcoding Pattern)
    // @why Declarative schema enables Portal UI editing + hot rebuild via RPC.
    //      Redis override (SYSTEM:INDEX_SCHEMA:{serviceName}) takes priority.
    //      If no Redis config exists, these local definitions are used as fallback.
    //
    // Format: { entityName: { name, prefix, schema } }
    //   name   — RediSearch index name (convention: idx:{service}_{entity})
    //   prefix — Redis key prefix to index (convention: SERVICE:ENTITY:)
    //   schema — FT.CREATE SCHEMA arguments array
    //
    // See: library/indexer.js for the unified index manager.
    indexes: {
        /* Example: uncomment when your entity reaches 1000+ records
        item: {
            name: 'idx:sample_item',
            prefix: 'SAMPLE:ITEM:',
            schema: [
                '$.name',      'AS', 'name',       'TAG', 'WITHSUFFIXTRIE',
                '$.status',    'AS', 'status',     'TAG',
                '$.createdAt', 'AS', 'created_at', 'NUMERIC', 'SORTABLE',
            ],
        },
        */
    },

    // 初始化数据种子 (Config over Hardcoding Pattern)
    // 用于 bootstrap.js 启动时自动初始化基础数据
    seeds: {
        categories: [
            /* Data Structure Example:
            {
                key: 'SAMPLE_TYPE',
                type: 'LIST', // LIST or TREE
                scope: 'LOCAL',
                desc: 'Sample Classification',
                items: [
                    { id: 'type_a', label: { zh: '类型A', en: 'Type A' } },
                    { id: 'type_b', label: { zh: '类型B', en: 'Type B' } } // ...
                ]
            }
            */
        ]
    }
};
