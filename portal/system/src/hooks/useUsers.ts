import { useState, useEffect, useCallback } from 'react';
import { callRpc } from '../utils/rpc';
import type { User } from '../types';

interface UseUsersProps {
    page: number;
    searchKeyword: string;
}

export function useUsers({ page, searchKeyword }: UseUsersProps) {
    const [users, setUsers] = useState<User[]>([]);
    const [total, setTotal] = useState(0);
    const [pageSize, setPageSize] = useState(50);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchUsers = useCallback(async (keywordOverride?: string) => {
        setLoading(true);
        setError(null);
        try {
            const queryKeyword = typeof keywordOverride === 'string' ? keywordOverride : searchKeyword;
            const result = await callRpc<{ users: User[], total: number, pageSize: number }>('user.account.list', {
                page,
                keyword: queryKeyword,
                includeDeleted: true
            });

            const sortedUsers = result.users.sort((a, b) =>
                new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            );

            setUsers(sortedUsers);
            setTotal(result.total);
            if (result.pageSize) {
                setPageSize(result.pageSize);
            }
        } catch (err: any) {
            console.error('Failed to fetch users:', err);
            setError(err.message || 'Failed to load users');
        } finally {
            setLoading(false);
        }
    }, [page, searchKeyword]);

    useEffect(() => {
        fetchUsers();
    }, [fetchUsers]);

    const updateUserInfo = useCallback((uid: string, updates: Partial<User>) => {
        setUsers(prev => prev.map(u => u.id === uid ? { ...u, ...updates } : u));
    }, []);

    return {
        users,
        total,
        pageSize,
        loading,
        error,
        refresh: fetchUsers,
        updateUserInfo
    };
}
