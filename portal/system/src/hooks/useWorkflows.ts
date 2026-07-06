import { useState, useEffect, useCallback } from 'react';
import { callRpc } from '../utils/rpc';
import type { Workflow } from '../types';

interface UseWorkflowsProps {
    page: number;
    pageSize: number;
}

export function useWorkflows({ page, pageSize }: UseWorkflowsProps) {
    const [workflows, setWorkflows] = useState<Workflow[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchWorkflows = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await callRpc<{ items: Workflow[], total: number }>(
                'orchestrator.workflow.list',
                {
                    includeDeleted: false,
                    limit: pageSize,
                    offset: (page - 1) * pageSize
                }
            );
            setWorkflows(result.items || []);
            setTotal(result.total || 0);
        } catch (err: any) {
            console.error('Failed to fetch workflows:', err);
            setError(err.message || 'Failed to load workflows');
        } finally {
            setLoading(false);
        }
    }, [page, pageSize]);

    useEffect(() => {
        fetchWorkflows();
    }, [fetchWorkflows]);

    const updateWorkflowState = useCallback((id: string, updates: Partial<Workflow>) => {
        setWorkflows(prev => prev.map(w => w.id === id ? { ...w, ...updates } : w));
    }, []);

    const deleteWorkflow = async (id: string) => {
        await callRpc('orchestrator.workflow.delete', { id });
        await fetchWorkflows();
    };

    const restoreWorkflow = async (id: string) => {
        await callRpc('orchestrator.workflow.restore', { id });
        await fetchWorkflows();
    };

    return {
        workflows,
        total,
        loading,
        error,
        refresh: fetchWorkflows,
        updateWorkflowState,
        deleteWorkflow,
        restoreWorkflow
    };
}
