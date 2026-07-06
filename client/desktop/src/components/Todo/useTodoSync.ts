import { useState, useEffect, useRef } from "react";
import { callRpc } from "../../lib/rpc";

export interface PlannerTodo {
    id: string;
    title: string;
    content: string;
    tags: string[];
    updatedAt: number;
    pinned?: boolean;
    completed?: boolean;
    ext?: {
        color?: string;
        [key: string]: any;
    };
}

const STORAGE_KEY = "solo_todos";

export function useTodoSync(onIdMapped?: (idMap: Record<string, string>) => void) {
    const [todos, setTodos] = useState<PlannerTodo[]>(() => {
        const saved = localStorage.getItem(STORAGE_KEY);
        try {
            return saved ? JSON.parse(saved) : [];
        } catch (e) {
            console.error("Failed to parse local todos:", e);
            return [];
        }
    });

    const [initialLoadDone, setInitialLoadDone] = useState(false);
    const syncTimerRef = useRef<any>(null);

    // Initial load from server
    useEffect(() => {
        const fetchInitial = async () => {
            try {
                const result = await callRpc("planner.todo.list", {});
                if (result && Array.isArray(result)) {
                    // Simple merge: server wins for existing, keep local-only
                    setTodos(prev => {
                        const merged = [...prev];
                        result.forEach((serverTodo: PlannerTodo) => {
                            const index = merged.findIndex(t => t.id === serverTodo.id);
                            if (index > -1) {
                                // If server is newer or same, update
                                if (serverTodo.updatedAt >= (merged[index].updatedAt || 0)) {
                                    merged[index] = serverTodo;
                                }
                            } else {
                                merged.push(serverTodo);
                            }
                        });
                        return merged;
                    });
                }
                setInitialLoadDone(true);
            } catch (err) {
                console.warn("Initial todo fetch failed:", err);
                setInitialLoadDone(true);
            }
        };
        fetchInitial();
    }, []);

    // Persist to local and sync to server
    useEffect(() => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));

        if (!initialLoadDone) return;

        if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
        syncTimerRef.current = setTimeout(async () => {
            try {
                const result = await callRpc("planner.todo.sync", { todos });
                if (result && result.idMap) {
                    // Update local IDs for newly created items
                    setTodos(prev => prev.map(todo => {
                        if (result.idMap[todo.id]) {
                            return { ...todo, id: result.idMap[todo.id] };
                        }
                        return todo;
                    }));
                    if (onIdMapped) onIdMapped(result.idMap);
                }
            } catch (err) {
                console.error("Todo sync failed:", err);
            }
        }, 2000);

        return () => clearTimeout(syncTimerRef.current);
    }, [todos, initialLoadDone]);

    const addTodo = (title: string = "New Todo", content: string = "# New Todo") => {
        const newTodo: PlannerTodo = {
            id: `local-${Date.now()}`,
            title,
            content,
            tags: [],
            updatedAt: Date.now(),
            completed: false
        };
        setTodos(prev => [...prev, newTodo]);
        return newTodo;
    };

    const updateTodo = (id: string, updates: Partial<PlannerTodo>) => {
        setTodos(prev => prev.map(todo =>
            todo.id === id ? { ...todo, ...updates, updatedAt: Date.now() } : todo
        ));
    };

    const deleteTodo = (id: string) => {
        setTodos(prev => prev.filter(todo => todo.id !== id));
    };

    return {
        todos,
        addTodo,
        updateTodo,
        deleteTodo,
        initialLoadDone
    };
}
