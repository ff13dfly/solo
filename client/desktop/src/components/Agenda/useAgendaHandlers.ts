import { useCallback } from 'react';
import { AgendaEvent, roundToInterval, HOUR_HEIGHT } from './AgendaTypes';
import { parseDate } from './DateUtils';

interface UseAgendaHandlersProps {
    events: AgendaEvent[];
    onAddEvent: (event: AgendaEvent) => void;
    onUpdateEvent: (event: AgendaEvent) => void;
    popovers: {
        closePickers: () => void;
        mentionSearch: string | null;
        handleTitleChangeForMentions?: (val: string, el: any, onSearch: (s: string | null) => void) => void;
        setMentionSearch?: (s: string | null) => void;
    };
    dragProps: {
        setDraft: React.Dispatch<React.SetStateAction<Partial<AgendaEvent> | null>>;
        setEditingId: React.Dispatch<React.SetStateAction<string | null>>;
        setSelectedId: React.Dispatch<React.SetStateAction<string | null>>;
        draft: Partial<AgendaEvent> | null;
        editingId: string | null;
        onBackgroundPointerDown: (e: React.PointerEvent) => void;
    };
}

export function useAgendaHandlers({ events, onAddEvent, onUpdateEvent, popovers, dragProps }: UseAgendaHandlersProps) {
    const { setDraft, setEditingId, setSelectedId, draft, editingId, onBackgroundPointerDown } = dragProps;

    const handleDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>, dateStr: string) => {
        e.stopPropagation();
        e.preventDefault();
        onBackgroundPointerDown(e as any);
        const rect = e.currentTarget.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const roundedY = roundToInterval(y, HOUR_HEIGHT / 4);

        const baseDate = parseDate(dateStr);
        const startTime = baseDate.getTime() + (roundedY / HOUR_HEIGHT) * 3600000;
        const endTime = startTime + 3600000;

        const newId = `draft-${Math.random().toString(36).substring(7)}`;
        const newDraft: Partial<AgendaEvent> = {
            id: newId,
            title: "",
            startTime,
            endTime,
            date: dateStr,
            ext: {}
        };

        setDraft(newDraft);
        setEditingId(newId);
        setSelectedId(newId);
        popovers.closePickers();
    }, [onBackgroundPointerDown, setDraft, setEditingId, setSelectedId, popovers]);

    const handleConfirmDraft = useCallback(() => {
        if (!draft || !draft.title?.trim()) {
            setDraft(null);
            setEditingId(null);
            setSelectedId(null);
            return;
        }

        onAddEvent({
            ...draft,
            id: Math.random().toString(36).substring(7),
            title: draft.title.trim(),
            date: draft.date
        } as AgendaEvent);

        setDraft(null);
        setEditingId(null);
        setSelectedId(null);
    }, [draft, onAddEvent, setDraft, setEditingId, setSelectedId]);

    const handleUpdateConfirm = useCallback((id: string) => {
        if (popovers.mentionSearch !== null) return;

        if (id && id.startsWith('draft-')) {
            handleConfirmDraft();
            return;
        }
        const event = events.find(e => e.id === id);
        if (event && draft && draft.title?.trim()) {
            onUpdateEvent({ ...event, ...draft, title: draft.title.trim() });
        }
        setEditingId(null);
        setDraft(null);
    }, [events, draft, onUpdateEvent, handleConfirmDraft, setEditingId, setDraft, popovers.mentionSearch]);

    const handleTitleChange = useCallback((id: string, title: string, e?: React.ChangeEvent<HTMLTextAreaElement>) => {
        setDraft(prev => prev ? { ...prev, title } : { title });

        if (e && e.target && popovers.handleTitleChangeForMentions) {
            popovers.handleTitleChangeForMentions(
                title,
                e.target,
                (search: string | null) => {
                    popovers.setMentionSearch?.(search);
                }
            );
        }
    }, [setDraft, popovers]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent, id: string) => {
        if (popovers.mentionSearch !== null) {
            if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Escape") {
                return;
            }
        }
        if (e.key === "Enter") handleUpdateConfirm(id);
        if (e.key === "Escape") {
            setEditingId(null);
            setDraft(null);
        }
    }, [popovers.mentionSearch, handleUpdateConfirm, setEditingId, setDraft]);

    const handleEdit = useCallback((id: string) => {
        const event = events.find(e => e.id === id);
        if (event) {
            setEditingId(id);
            setSelectedId(id);
            setDraft({ ...event });
        }
        popovers.closePickers();
    }, [events, setEditingId, setSelectedId, setDraft, popovers]);

    return {
        handleDoubleClick,
        handleConfirmDraft,
        handleUpdateConfirm,
        handleTitleChange,
        handleKeyDown,
        handleEdit
    };
}
