export interface CategoryItem {
    id: string;
    label: Record<string, string> | string;
    desc: string;
    parentId?: string;
    createdAt: number;
}

export interface CategoryConfig {
    key: string;
    label: Record<string, string> | string;
    desc: string;
    items: CategoryItem[];
}

export interface UserDevice {
    last: string;
    token_prefix: string;
}

export interface Permit {
    allow_all: boolean;
    services: Record<string, string[]>;
    /** 数据级字段约束:{ method | '*': { hide?: string[] } | { show?: string[] } }。
     *  Router 透传给微服务,由 library/fieldmask 在返回前按调用方约束遮蔽字段。 */
    constraints?: Record<string, { hide?: string[]; show?: string[] }>;
}

export interface User {
    id: string;
    name: string;
    way: number;
    devices: Record<string, UserDevice>;
    createdAt: string;
    last: string;
    categories?: Record<string, string>;
    permit?: Permit;
    status?: string;
}

export interface Bot {
    id: string;
    name: string;
    type: 'bot';
    hash: null;
    permit: Permit;
    desc: string;
    createdAt: string;
    updatedAt?: string;
    status: 'ACTIVE' | 'DELETED';
}

export interface WorkflowStep {
    id: string;
    service: string;
    method: string;
    params: Record<string, any>;
}

export interface Resolver {
    source: string;
    method: string;
    params: Record<string, string>;
    extract: string;
}

export interface Keyword {
    word: string;
    source: 'seed' | 'ai';
    count?: number;
}

export interface Workflow {
    id: string;
    name: string;
    desc: string;
    category: Record<string, string> | string;
    priority: number;
    status: string;
    steps: WorkflowStep[];
    resolvers?: Record<string, Resolver>;
    keywords?: Keyword[];
    tags: string[];
    examples?: string[];
    negative?: string[];
    synonyms?: Record<string, string[]>;
    required_inputs?: string[];
    optional_inputs?: string[];
    createdAt: number;
    updatedAt: number;
    prompts?: string[];
    // C1 approval gate fields
    submittedBy?: string | null;
    approvals?: Array<{ approvedBy: string; approvedAt: number }>;
    deniedBy?: string | null;
    denialReason?: string | null;
}

export interface RPCMethod {
    name: string;
    description?: string;
    params?: any[];
    returns?: any;
    ai?: boolean;
}

export interface ServiceInfo {
    id: string;
    url: string;
    methods: RPCMethod[];
    status: 'active' | 'unknown' | 'error' | 'online' | 'offline';
    lastSeen?: string;
    version?: string;
    entities?: Record<string, any>;
}
