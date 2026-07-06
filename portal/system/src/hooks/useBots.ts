import { useState, useEffect, useCallback } from 'react';
import { callRpc } from '../utils/rpc';
import type { Bot } from '../types';

export function useBots() {
    const [bots, setBots] = useState<Bot[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchBots = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await callRpc<{ items: Bot[] }>('user.bot.list', {});
            setBots(Array.isArray(result?.items) ? result.items : []);
        } catch (err: any) {
            console.error('Failed to fetch bots:', err);
            setError(err.message || 'Failed to load bots');
            setBots([]);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchBots();
    }, [fetchBots]);

    const updateBotInfo = useCallback((uid: string, updates: Partial<Bot>) => {
        setBots(prev => prev.map(b => b.id === uid ? { ...b, ...updates } : b));
    }, []);

    return {
        bots,
        loading,
        error,
        refresh: fetchBots,
        updateBotInfo,
    };
}
