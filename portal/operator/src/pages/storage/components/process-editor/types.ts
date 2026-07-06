export interface Action {
    id: string;
    text: string;
    rpc: string;
    target?: string;
    params?: any;
    type?: 'PRIMARY' | 'SUCCESS' | 'DANGER' | 'GHOST';
}

export interface Flow {
    ui: {
        title: string;
        icon?: string;
        color?: string;
        actions?: Action[];
    };
}

export interface ProcessDefinition {
    id: string;
    name: string;
    version: string;
    flows: Record<string, Flow>;
}
