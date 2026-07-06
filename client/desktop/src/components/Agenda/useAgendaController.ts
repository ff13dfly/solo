import { useCallback, useMemo } from 'react';
import { AgendaEvent, ViewType, HOUR_HEIGHT } from './AgendaTypes';
import { useAgendaNavigation } from './useAgendaNavigation';
import { useAgendaDrag } from './useAgendaDrag';
import { useAgendaHandlers } from './useAgendaHandlers';
import { PlannerTodo } from '../Todo/useTodoSync';

interface UseAgendaControllerProps {
    events: AgendaEvent[];
    todos: PlannerTodo[];
    onAddEvent: (event: AgendaEvent) => void;
    onUpdateEvent: (event: AgendaEvent) => void;
    onDeleteEvent: (id: string) => void;
    scrollRef: React.RefObject<HTMLDivElement>;
    popovers: {
        openColorPicker: (rect: DOMRect, id: string) => void;
        openTodoPicker: (rect: DOMRect, id: string) => void;
        closePickers: () => void;
        mentionSearch: string | null;
        handleTitleChangeForMentions?: (val: string, el: any, onSearch: (s: string | null) => void) => void;
        setMentionSearch?: (s: string | null) => void;
    };
    onSelectDate?: (date: Date) => void;
    now: Date;
}

export function useAgendaController({
    events,
    todos,
    onAddEvent,
    onUpdateEvent,
    onDeleteEvent,
    scrollRef,
    popovers,
    onSelectDate,
    now
}: UseAgendaControllerProps) {
    // 1. Navigation State
    const navigation = useAgendaNavigation();

    // 2. Drag & State (Drafts, Editing, Selection)
    const dragProps = useAgendaDrag({
        events,
        onUpdateEvent,
        scrollRef
    });

    // 3. Action Handlers
    const handlers = useAgendaHandlers({
        events,
        onAddEvent,
        onUpdateEvent,
        popovers,
        dragProps
    });

    const nowPosition = useMemo(() => {
        const minutes = now.getHours() * 60 + now.getMinutes();
        // Shifted by GRID_TOP_PADDING (20px) to align with grid lines
        return (minutes / 60) * HOUR_HEIGHT;
    }, [now]);

    // 4. Unified Interaction Object
    const interaction = useMemo(() => ({
        // State
        now,
        nowPosition,
        activeView: navigation.activeView,
        viewDate: navigation.viewDate,
        selectedDate: navigation.selectedDate,
        draggingId: dragProps.draggingId,
        selectedId: dragProps.selectedId,
        editingId: dragProps.editingId,
        draft: dragProps.draft,
        setDraft: dragProps.setDraft,

        // Navigation Actions
        setActiveView: navigation.setActiveView,
        setViewDate: navigation.setViewDate,
        setSelectedDate: navigation.setSelectedDate,
        handleNavigate: navigation.handleNavigate,
        handleScrollToToday: navigation.handleScrollToToday,
        handleDateSelect: (date: Date) => {
            navigation.setSelectedDate(date);
            navigation.setViewDate(date);
            navigation.setActiveView("日");
            onSelectDate?.(date);
        },

        // Interaction Actions
        onPointerDown: dragProps.onPointerDown,
        onBackgroundPointerDown: dragProps.onBackgroundPointerDown,

        // Handler Actions
        onDoubleClick: handlers.handleDoubleClick,
        onEdit: handlers.handleEdit,
        onTitleChange: handlers.handleTitleChange,
        onKeyDown: handlers.handleKeyDown,
        onBlur: handlers.handleUpdateConfirm,
        onConfirmDraft: handlers.handleConfirmDraft,

        // Popover Actions (Proxied for convenience)
        onColorClick: popovers.openColorPicker,
        onTodoClick: popovers.openTodoPicker,

        // Business Logic
        onUpdateEvent: onUpdateEvent,
        onDeleteEvent
    }), [
        now,
        nowPosition,
        navigation,
        dragProps,
        handlers,
        popovers,
        onUpdateEvent,
        onDeleteEvent
    ]);

    return {
        navigation,
        dragProps,
        handlers,
        interaction
    };
}
