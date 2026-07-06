require('dotenv').config();
const pkg = require('./package.json');
const { portFor, urlFor } = require('../../library/ports');

module.exports = {
    port: portFor('planner', 8030),
    debug: process.env.DEBUG === 'true',
    serviceName: process.env.SERVICE_NAME || 'planner',
    version: pkg.version,
    pageSize: 20,
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6699',
    routerUrl: process.env.ROUTER_URL || urlFor('router', 8600),
    routerPublicKey: process.env.ROUTER_PUBLIC_KEY || '8HrBBG5X9BSKWFaX8QW7hoektDyRZFePb2R9Ad5D84ji',

    // ID Length Configuration
    idLengths: {
        agenda: 8,
        todo: 8,
        category: 6
    },

    redis: {
        agendaPrefix: 'PLANNER:AGENDA:',
        todoPrefix: 'PLANNER:TODO:'
    },

    // AI 语义描述 (用于 Agent 意图识别)
    description: {
        en: {
            main: [
                "personal productivity service integrating calendar and tasks",
                "manages agendas (time blocks) and long-term todos (markdown)",
                "provides AI-ready project insights"
            ],
            methods: {
                // System Methods
                "ping": ["health check endpoint"],
                "methods": ["get service method list"],
                "entities": ["get entity definitions (schema)"],

                // Agenda Management
                "planner.agenda.create": ["create a new calendar agenda item"],
                "planner.agenda.get": ["retrieve agenda details by ID"],
                "planner.agenda.update": ["update an existing agenda"],
                "planner.agenda.delete": ["remove an agenda item"],
                "planner.agenda.list": ["list agendas for a user or date range"],
                "planner.agenda.sync": ["bulk synchronize local agendas with the server"],
                "planner.todo.create": ["create a new long-term todo (markdown)"],
                "planner.todo.get": ["retrieve todo details including content"],
                "planner.todo.update": ["update todo content or metadata"],
                "planner.todo.delete": ["soft delete a todo"],
                "planner.todo.list": ["list todos matching criteria"],
                "planner.todo.schedule": ["schedule a todo"],
                "planner.todo.sync": ["bulk synchronize local todos with the server"],
                "planner.todo.analyze": ["request AI analysis of a project's status"]
            }
        },
        zh: {
            main: [
                "集成日历与任务管理的个人生产力服务",
                "管理日程（时间块）和长期待办（Markdown）",
                "提供面向 AI 的项目态势感知能力"
            ],
            methods: {
                // 系统方法
                "ping": ["健康检查端点"],
                "methods": ["获取服务方法列表"],
                "entities": ["获取实体定义 (Schema)"],

                // 日程管理
                "planner.agenda.create": ["创建新的日历日程项"],
                "planner.agenda.get": ["根据 ID 获取日程详情"],
                "planner.agenda.update": ["更新现有日程"],
                "planner.agenda.delete": ["删除日程项"],
                "planner.agenda.list": ["列出用户或特定日期范围的日程"],
                "planner.agenda.sync": ["将本地日程批量同步至服务器"],
                "planner.todo.create": ["创建新的长期待办 (Markdown)"],
                "planner.todo.get": ["获取待办详情及内容"],
                "planner.todo.update": ["更新待办内容 or 元数据"],
                "planner.todo.delete": ["软删除待办"],
                "planner.todo.list": ["列出所有符合条件的待办事项"],
                "planner.todo.schedule": ["排期待办事项"],
                "planner.todo.sync": ["将本地待办任务批量同步至服务器"],
                "planner.todo.analyze": ["请求 AI 对项目状态进行态势分析"]
            }
        }
    },

    seeds: {
        categories: []
    }
};
