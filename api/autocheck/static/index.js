/**
 * Autocheck 模块索引
 * 导出所有检查模块供主入口使用
 */

module.exports = {
    structure: require('./structure'),
    config: require('./config-check'),
    idNaming: require('./id-naming'),
    rpcNaming: require('./rpc-naming'),
    jsonrpcProtocol: require('./jsonrpc-protocol'),
    security: require('./security'),
    logging: require('./logging'),
    introspection: require('./introspection'),
    redisKeys: require('./redis-keys'),
    redisScanNormalize: require('./redis-scan-normalize'),
    dependencies: require('./dependencies'),
    // 新增模块
    startup: require('./startup'),
    routeConsistency: require('./route-consistency'),
    mockData: require('./mock-data'),
    testRunner: require('./test-runner'),
    memoryLeakStatic: require('./memory-leak-static'),
    memoryLeakDynamic: require('./memory-leak-dynamic'),
    semantic: require('./semantic-check'),
    syntax: require('./syntax-check'),
    // Ed25519 握手规范检查
    ed25519Handshake: require('./ed25519-handshake'),
    // 联邦分类协议检查
    category: require('./category-check'),
    // 本地 node_modules 检测
    nodeModules: require('./node-modules-check'),
    // Core lib 路径检查
    pathCheck: require('./path-check'),
    // 测试覆盖率检查
    testCoverage: require('./test-coverage'),
    // 测试目录结构检查
    testStructure: require('./test-structure'),
    // Portal 兼容性检查
    portalCompat: require('./portal-compat'),
    // Entity Factory 使用规范检查
    entityFactory: require('./entity-factory'),
    // 实体定义规范检查
    entitiesDefinition: require('./entities-definition'),
    // 软删除一致性检查
    softDelete: require('./soft-delete-check'),
    // WAL Context 注入检查
    walContext: require('./wal-context'),
    // RediSearch 合规检查 (storageType: 'json', ensureIndex, 迁移脚本)
    rediSearch: require('./redis-search-check'),
    // _tasks 结构规范检查 (必须含 method 字段，Router 依赖此字段路由任务)
    tasksCheck: require('./tasks-check'),
    // 裸 throw new Error() 检查 (logic 层应使用标准 jsonrpc 错误码)
    throwCheck: require('./throw-check'),
    // 监听网卡检查 (app.listen 是否可经 BIND_ADDR 控制，而非永远绑所有网卡)
    bindAddress: require('./bind-address'),
    // JsonLogic 求值来源 (必须经 library/jsonlogic.js —— 裸库对缺失操作数 fail-open)
    jsonlogicSource: require('./jsonlogic-source'),
    // 行隔离上下文检查 (walContext.run 是否经 requestContext 注入 $owner，使 Entity Factory 能自动执行行隔离)
    ownerContext: require('./owner-context'),
    // 架构稳定性与防击穿检测
    paginationSafety: require('./pagination-safety'),
    inlineErrors: require('./inline-errors'),
    redisTransaction: require('./redis-transaction'),
    floatingPromise: require('./floating-promise'),
    taskThrottleCheck: require('./task-throttle-check'),
    // 健壮性检测（issue_20260425 经验提炼）
    deadConfigKey: require('./dead-config-key'),
    workerTaskId: require('./worker-taskid'),
    unboundedConcurrency: require('./unbounded-concurrency'),
    // 异步与进程安全检测
    eventListenerLeak: require('./event-listener-leak'),
    intervalCleanup: require('./interval-cleanup'),
    childProcessSafety: require('./child-process-safety'),
    // 模拟测试覆盖检测
    simulationCoverage: require('./simulation-coverage'),
    // relay.js 使用合规检查（security.md §7.7 — 禁止自实现 bot token 生命周期）
    relayCheck: require('./relay-check'),
    // 参数 Schema 强度检查（string 参数是否声明 maxLength；WARN 级，参数加强推广清单）
    paramSchema: require('./param-schema'),
    // 事件边界声明检查（handlers/events.js 存在 + 结构正确 + 已注册到 jsonrpc 路由）
    eventsCheck: require('./events-check'),
    // 基建参数命名约定（token/expiresAt/page… 跨服务类型一致 — fulfillment expiresAt 事故）
    paramConventions: require('./param-conventions'),
    // auth 分叉禁令（Router-token 验签必须经 library/auth — events 白名单三连漏事故）
    authForkCheck: require('./auth-fork-check'),
    // public 面白名单守门（toFix.md 二.router — checkAccess public 面无 Router 侧白名单 ceiling 的服务侧缓解）
    publicSurfaceCheck: require('./public-surface-check'),
    // 时间字段形态与时间源检查（epoch ms 是 factory standard；声明↔实现对账 — SKILL.md 红线唯一没有门禁的一条）
    clockCheck: require('./clock-check'),
    // fleet-standard guide 覆盖检查（'guide' 方法接线 + GUIDE.md 存在，WARN 级 — AI 自描述 API）
    guideCheck: require('./guide-check'),
};
