import { useState, useEffect, useRef } from "react";
import { AgendaEvent } from "./AgendaTypes";
import { callRpc } from "../../lib/rpc";

const STORAGE_KEY = "SOLO_AGENDA_EVENTS";

export function useAgendaSync() {
    // Initial load from LocalStorage
    const [events, setEvents] = useState<AgendaEvent[]>(() => {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                return Array.isArray(parsed) ? parsed : [];
            } catch (e) {
                console.error("Failed to parse agenda events from localStorage", e);
            }
        }
        return [];
    });

    const [initialLoadDone, setInitialLoadDone] = useState(false);
    const syncTimerRef = useRef<any>(null);

    // Initial load from server
    useEffect(() => {
        const fetchInitial = async () => {
            try {
                const result = await callRpc("planner.agenda.list", {});
                if (result && result.items) {
                    setEvents(result.items as AgendaEvent[]);
                }
                setInitialLoadDone(true);
            } catch (err) {
                console.warn("Initial agenda fetch failed:", err);
                setInitialLoadDone(true); // Still mark as done so sync can resume
            }
        };
        fetchInitial();
    }, []);

    // Persist to LocalStorage immediately on every change
    useEffect(() => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(events));

        // Only sync to server if we've successfully attempted initial load
        if (!initialLoadDone) return;

        // Debounced Server Sync (2 seconds)
        if (syncTimerRef.current) {
            clearTimeout(syncTimerRef.current);
        }

        syncTimerRef.current = setTimeout(async () => {
            try {
                const result = await callRpc("planner.agenda.sync", { events });

                // If server returned an ID map (front -> back), update local state
                if (result && result.idMap && Object.keys(result.idMap).length > 0) {
                    setEvents(prev => prev.map(ev => {
                        const newId = result.idMap[ev.id];
                        return newId ? { ...ev, id: newId } : ev;
                    }));
                }
            } catch (err) {
                console.warn("Agenda server sync failed:", err);
            }
        }, 2000);

        return () => {
            if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
        };
    }, [events]);

    const addEvent = (event: AgendaEvent) => {
        // Use a temporary local ID that the server will replace
        const localId = `local-${Math.random().toString(36).substring(7)}`;
        setEvents(prev => [...prev, { ...event, id: localId }]);
    };

    const updateEvent = (updatedEvent: AgendaEvent) => {
        setEvents(prev => prev.map(ev => ev.id === updatedEvent.id ? updatedEvent : ev));
    };

    const deleteEvent = (id: string) => {
        setEvents(prev => prev.filter(ev => ev.id !== id));
    };

    return {
        events,
        setEvents,
        addEvent,
        updateEvent,
        deleteEvent
    };
}
