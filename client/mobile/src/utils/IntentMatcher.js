/**
 * IntentMatcher - 前端意图匹配模块
 * 实现 flow.md 中描述的 Two-Step Matching 流程
 * 
 * 用法:
 *   const matcher = new IntentMatcher(rpcCall);
 *   await matcher.init(); // 登录后调用一次
 *   const result = await matcher.match("新来一个员工，陈大力，手机13301232233，设计部设计师");
 */

class IntentMatcher {
    constructor(rpcCall) {
        // rpcCall: 发起 JSON-RPC 请求的函数，签名: (method, params) => Promise<result>
        this.rpcCall = rpcCall;
        this.cache = null;
        this.cacheKey = 'system_capability_list';
        this.cacheTTL = 24 * 60 * 60 * 1000; // 24 小时
    }

    /**
     * 初始化：获取并缓存系统能力数据
     * 登录成功后调用一次
     */
    async init() {
        if (this.isCacheValid()) {
            this.cache = JSON.parse(localStorage.getItem(this.cacheKey));
            console.log('[IntentMatcher] Using cached capabilities');
            return;
        }

        console.log('[IntentMatcher] Fetching capabilities...');

        // 1. 获取服务描述
        const services = await this._fetchServices();

        // 2. 获取方法列表
        const methods = await this._fetchMethods();

        // 3. 获取工作流分类
        const workflowCategories = await this._fetchWorkflowCategories();

        // 4. 获取所有工作流（按分类）
        const workflows = {};
        for (const category of workflowCategories) {
            const result = await this.rpcCall('orchestrator.workflow.list', {
                category: category.key || category.id
            });
            workflows[category.key || category.id] = result.items || result || [];
        }

        // 5. 存储
        this.cache = {
            services,
            methods,
            workflowCategories,
            workflows,
            timestamp: Date.now()
        };

        localStorage.setItem(this.cacheKey, JSON.stringify(this.cache));
        console.log('[IntentMatcher] Capabilities cached');
    }

    /**
     * 主入口：匹配用户意图
     * @param {string} userInput - 用户输入
     * @param {string} memory - 格式化的记忆上下文字符串（来自 useMemory hook）
     * @returns {Promise<Object>} - 匹配结果
     */
    async match(userInput, memory = '') {
        if (!userInput || !userInput.trim()) {
            throw new Error('User input cannot be empty');
        }
        if (!this.cache) {
            throw new Error('IntentMatcher not initialized. Call init() first.');
        }

        console.log('[IntentMatcher] Matching:', userInput);

        // Phase 1: 粗筛
        const phase1 = await this._phase1(userInput, memory);
        console.log('[IntentMatcher] Phase 1 Result:', phase1);

        if (!phase1.services?.length && !phase1.categories?.length) {
            return { type: 'fallback', method: 'agent.chat', reason: 'No match in Phase 1' };
        }

        // Phase 2: 精筛
        const phase2 = await this._phase2(userInput, phase1, memory);
        console.log('[IntentMatcher] Phase 2 Result:', phase2);

        if (!phase2.candidates || phase2.candidates.length === 0) {
            return { type: 'fallback', method: 'agent.chat', reason: 'No match in Phase 2' };
        }

        // Always return the top candidate as the primary match for now
        // But include the full candidates list for future UI "Secondary Hit" support
        const topCandidate = phase2.candidates[0];
        return {
            ...topCandidate,
            // Preserve full list for UI
            allCandidates: phase2.candidates
        };
    }

    /**
     * Phase 1: 粗筛 - 匹配服务和工作流分类
     */
    async _phase1(userInput, memory = '') {
        // 格式化服务列表
        const servicesPrompt = Object.entries(this.cache.services).map(([name, desc]) => {
            if (typeof desc === 'object' && desc.zh?.main) {
                return `- ${name}: ${desc.zh.main.join('; ')}`;
            }
            return `- ${name}: ${desc}`;
        });

        // 格式化分类列表
        const categoriesPrompt = this.cache.workflowCategories.map(cat => {
            const label = cat.label?.zh || cat.name || cat.key;
            return `- ${cat.key || cat.id}: ${label} (${cat.desc || ''})`;
        });

        const result = await this.rpcCall('agent.purpose', {
            text: userInput,
            memory: memory, // Memory context from useMemory hook
            phase: 1,
            context: {
                services: servicesPrompt,
                categories: categoriesPrompt
            }
        });

        return result;
    }

    /**
     * Phase 2: 精筛 - 匹配具体方法/工作流 + 提取参数
     */
    async _phase2(userInput, phase1Result, memory = '') {
        // 提取选中服务的方法
        const selectedMethods = [];
        const selectedServiceNames = phase1Result.services?.map(s => s.name) || [];

        for (const [methodName, meta] of Object.entries(this.cache.methods)) {
            if (selectedServiceNames.includes(meta.service)) {
                const paramsStr = meta.params ? ` (params: ${meta.params.map(p => p.name).join(', ')})` : '';
                selectedMethods.push(`- ${methodName}: ${meta.desc}${paramsStr}`);
            }
        }

        // 提取选中分类的工作流
        const selectedWorkflows = [];
        const selectedCategoryKeys = phase1Result.categories?.map(c => c.key) || [];

        for (const categoryKey of selectedCategoryKeys) {
            const workflows = this.cache.workflows[categoryKey] || [];
            selectedWorkflows.push(...workflows);
        }

        const result = await this.rpcCall('agent.purpose', {
            text: userInput,
            memory: memory, // Memory context from useMemory hook
            phase: 2,
            context: {
                capabilities: selectedMethods,
                workflows: selectedWorkflows
            }
        });

        return result;
    }

    /**
     * 检查缓存是否有效
     */
    isCacheValid() {
        const cached = localStorage.getItem(this.cacheKey);
        if (!cached) return false;

        try {
            const data = JSON.parse(cached);
            return data.timestamp && (Date.now() - data.timestamp) < this.cacheTTL;
        } catch {
            return false;
        }
    }

    /**
     * 强制刷新缓存
     */
    async refresh() {
        localStorage.removeItem(this.cacheKey);
        this.cache = null;
        await this.init();
    }

    /**
     * 获取服务描述
     */
    async _fetchServices() {
        try {
            // 方式1: 通过 REST API
            const response = await fetch('/api/router/services');
            if (response.ok) {
                return await response.json();
            }
        } catch (e) {
            console.warn('[IntentMatcher] Failed to fetch from REST, trying RPC');
        }

        // 方式2: 通过 RPC 调用各服务的 introspection
        return await this.rpcCall('system.service.list', {});
    }

    /**
     * 获取方法列表
     */
    async _fetchMethods() {
        try {
            const response = await fetch('/api/router/capabilities');
            if (response.ok) {
                return await response.json();
            }
        } catch (e) {
            console.warn('[IntentMatcher] Failed to fetch methods from REST');
        }

        return await this.rpcCall('system.capability.list', {});
    }

    /**
     * 获取工作流分类
     */
    async _fetchWorkflowCategories() {
        try {
            const result = await this.rpcCall('orchestrator.category.list', {});
            return result.items || result || [];
        } catch (e) {
            console.warn('[IntentMatcher] Failed to fetch workflow categories');
            return [];
        }
    }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
    module.exports = IntentMatcher;
}
