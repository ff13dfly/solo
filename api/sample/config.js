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
    // Format: { entityName: { name, prefix, schema, language? } }
    //   name     — RediSearch index name (convention: idx:{service}_{entity})
    //   prefix   — Redis key prefix to index (convention: SERVICE:ENTITY:)
    //   schema   — FT.CREATE SCHEMA arguments array
    //   language — optional FT.CREATE LANGUAGE; set 'chinese' for CJK text (see below)
    //
    // 🔴 中文数据必读（实测：redis-stack 7.4.0-v8 / search 21020，5,860 条合成中文商品名）
    //   ① 默认 TEXT 对中文等于没建索引 —— 分词器按空格与标点切词，整串中文是一个 token，
    //      `@name:收纳` 命中 0 条。
    //   ② 下面 `$.name` 那条 TAG WITHSUFFIXTRIE 只能用 `@name:{*收纳*}` 查，那是通配查询，
    //      受全局 MAXPREFIXEXPANSIONS 约束（默认 200）且**超限静默截断**：实测 2,000 条
    //      命中只返回 200 条（10%），不报错、不告警。截断量与"有多少个不同的词命中通配"
    //      成正比 ⇒ 冷门词 100% 正确、高频词大量丢，**开发期小样本永远看不出来**。
    //      indexer.js 的 ensureAll()/rebuild() 现在会把这个上限一并调高（默认 200000，
    //      可用 REDISEARCH_MAXPREFIXEXPANSIONS 覆盖），所以这条路现在是通的。
    //   ③ 中文全文检索的正解是 `language: 'chinese'` + TEXT（见下面被注释的 cnItem），
    //      实测同一批数据召回 2,000/2,000。注意它按词切分，查询词若是索引词的前缀
    //      （"不锈钢" vs "不锈钢锅"）仍会漏 —— 要精确子串就仍用 ② 的 TAG，两者可并存。
    //
    // ⚠️ 改了 language 必须 rebuild：已存在的索引 ensureAll() 会跳过，
    //    光改配置重启没有任何效果，而症状是搜索结果静默不对。
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

        /* 中文文本检索：TEXT + language:'chinese'，查询写 `@name:收纳`（不是 `{*收纳*}`）
        cnItem: {
            name: 'idx:sample_cn_item',
            prefix: 'SAMPLE:ITEM:',
            language: 'chinese',
            schema: [
                '$.name',   'AS', 'name',   'TEXT',
                '$.status', 'AS', 'status', 'TAG',
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
