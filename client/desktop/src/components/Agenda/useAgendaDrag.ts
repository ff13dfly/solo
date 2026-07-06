import { useState, useRef, useCallback, useEffect } from 'react';
import { AgendaEvent, HOUR_HEIGHT, calculatePosition, roundToInterval } from './AgendaTypes';
import { parseDate } from './DateUtils';

export type DragMode = 'move' | 'resize-top' | 'resize-bottom';

interface UseAgendaDragProps {
    events: AgendaEvent[];
    onUpdateEvent: (event: AgendaEvent) => void;
    scrollRef: React.RefObject<HTMLDivElement>;
}

export function useAgendaDrag({ events, onUpdateEvent, scrollRef }: UseAgendaDragProps) {
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [draft, setDraft] = useState<Partial<AgendaEvent> | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);

    // High-frequency tracking refs
    const dragRef = useRef({
        id: null as string | null,
        mode: 'move' as DragMode,
        offset: 0,
        startY: 0,
        startX: 0, // Added startX for direction detection
        isMoving: false,
        isTitleArea: false,
        lastSnappedTop: -1,
        lastSnappedBottom: -1,
        initialEvent: null as AgendaEvent | null,
        evtTarget: null as HTMLElement | null, // Added target tracking
    });

    // Interaction sync refs
    const commitTimestampRef = useRef<number>(0);
    const eventsRef = useRef(events);
    eventsRef.current = events;

    // Effect to clear draft ONLY when the parent prop catches up or safety timeout hits
    // Removed aggressive draft clearing timeout.
    // The draft should only be cleared by explicit user action (save, cancel, click outside).

    const onPointerDown = useCallback((id: string, e: React.PointerEvent, mode: DragMode = 'move') => {
        if (e.button !== 0) return;

        const rect = scrollRef.current?.getBoundingClientRect();
        if (!rect) return;

        const targetEvent = eventsRef.current.find(ev => ev.id === id) || (draft?.id === id ? (draft as AgendaEvent) : null);
        if (!targetEvent) return;

        const target = e.currentTarget as HTMLElement;

        const currentMouseY = e.clientY - rect.top + (scrollRef.current?.scrollTop || 0);

        const initialTop = calculatePosition(targetEvent.startTime!);
        const initialBottom = calculatePosition(targetEvent.endTime!);

        // Detect if the click started on the title area (only for moving)
        const isTitleArea = mode === 'move' && (e.target as HTMLElement).closest('[data-agenda-title="true"]') !== null;

        dragRef.current = {
            id,
            mode,
            offset: mode === 'resize-bottom' ? currentMouseY - initialBottom : currentMouseY - initialTop,
            startY: e.clientY,
            startX: e.clientX,
            isMoving: false,
            isTitleArea,
            lastSnappedTop: initialTop,
            lastSnappedBottom: initialBottom,
            initialEvent: { ...targetEvent },
            evtTarget: target,
        };

        const handlePointerMove = (moveEvent: PointerEvent) => {
            const drag = dragRef.current;
            if (!drag.id || !drag.initialEvent) return;

            const distY = Math.abs(moveEvent.clientY - drag.startY);
            const distX = Math.abs(moveEvent.clientX - drag.startX);

            if (!drag.isMoving) {

                // Strictly separate horizontal swiping and vertical dragging
                if (distY > 5 || distX > 5) {
                    drag.isMoving = true;
                    if (drag.evtTarget) {
                        try { drag.evtTarget.setPointerCapture(moveEvent.pointerId); } catch (e) { }
                    }
                    setDraggingId(drag.id);
                    setSelectedId(drag.id);
                    setEditingId(null);
                    setDraft({ ...drag.initialEvent });
                } else {
                    return;
                }
            }

            const internalRect = scrollRef.current?.getBoundingClientRect();
            if (!internalRect) return;

            const moveY = moveEvent.clientY - internalRect.top + (scrollRef.current?.scrollTop || 0);
            const rawY = moveY - drag.offset;

            const snapInterval = HOUR_HEIGHT / 4;
            const snappedY = roundToInterval(rawY, snapInterval);

            // Detect target day column using robust element testing
            const elementsAtPoint = document.elementsFromPoint(moveEvent.clientX, moveEvent.clientY);
            let targetDateStr: string | null = null;
            for (const el of elementsAtPoint) {
                const dateAttr = (el as HTMLElement).closest('[data-date]')?.getAttribute('data-date');
                if (dateAttr) {
                    targetDateStr = dateAttr;
                    break;
                }
            }

            setDraft(currentDraft => {
                const baseEvent = currentDraft || drag.initialEvent;
                if (!baseEvent) return null;

                const minDurationMinutes = 15;
                const minHeight = (minDurationMinutes / 60) * HOUR_HEIGHT;

                if (drag.mode === 'move') {
                    // Check if anything changed: either Y position or target date
                    if (snappedY === drag.lastSnappedTop && (!targetDateStr || targetDateStr === baseEvent.date)) {
                        return currentDraft;
                    }
                    drag.lastSnappedTop = snappedY;

                    const activeDateStr = targetDateStr || baseEvent.date || drag.initialEvent?.date!;
                    const baseDateObj = parseDate(activeDateStr);
                    const startOfDay = baseDateObj.getTime();

                    const duration = (baseEvent.endTime as number) - (baseEvent.startTime as number);
                    const newStartTime = startOfDay + (snappedY / HOUR_HEIGHT) * 3600000;

                    return {
                        ...baseEvent,
                        date: activeDateStr,
                        startTime: newStartTime,
                        endTime: newStartTime + duration
                    };
                } else if (drag.mode === 'resize-top') {
                    if (snappedY === drag.lastSnappedTop) return currentDraft;

                    const bottomPos = calculatePosition(baseEvent.endTime!);
                    const clampedTop = Math.min(snappedY, bottomPos - minHeight);

                    drag.lastSnappedTop = clampedTop;
                    const baseDateObj = parseDate(baseEvent.date!);
                    const startOfDay = baseDateObj.getTime();

                    return {
                        ...baseEvent,
                        startTime: startOfDay + (clampedTop / HOUR_HEIGHT) * 3600000
                    };
                } else if (drag.mode === 'resize-bottom') {
                    if (snappedY === drag.lastSnappedBottom) return currentDraft;

                    const topPos = calculatePosition(baseEvent.startTime!);
                    const clampedBottom = Math.max(snappedY, topPos + minHeight);

                    drag.lastSnappedBottom = clampedBottom;
                    const baseDateObj = parseDate(baseEvent.date!);
                    const startOfDay = baseDateObj.getTime();

                    return {
                        ...baseEvent,
                        endTime: startOfDay + (clampedBottom / HOUR_HEIGHT) * 3600000
                    };
                }
                return currentDraft;
            });
        };

        const handlePointerUp = (upEvent: PointerEvent) => {
            const drag = dragRef.current;
            if (drag.evtTarget) {
                try { drag.evtTarget.releasePointerCapture(upEvent.pointerId); } catch (e) { }
            }
            cleanup();

            if (drag.id) {
                if (drag.isMoving) {
                    commitTimestampRef.current = Date.now();
                    const finalId = drag.id;
                    setDraft(currentDraft => {
                        if (currentDraft && currentDraft.startTime && currentDraft.endTime && !finalId.startsWith('draft-')) {
                            const original = eventsRef.current.find(ev => ev.id === finalId);
                            if (original) {
                                onUpdateEvent({
                                    ...original,
                                    date: currentDraft.date!,
                                    startTime: currentDraft.startTime as number,
                                    endTime: currentDraft.endTime as number
                                });
                            }
                        }
                        return currentDraft;
                    });
                } else {
                    // Click logic
                    setSelectedId(drag.id);
                    if (drag.isTitleArea) {
                        setEditingId(drag.id);
                        setDraft({ ...drag.initialEvent });
                    } else {
                        setEditingId(null);
                        setDraft(null);
                    }
                }

                setDraggingId(null);
                dragRef.current.id = null;
            }
        };

        const cleanup = () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
            window.removeEventListener('pointercancel', cleanup);
        };

        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);
        window.addEventListener('pointercancel', cleanup);
    }, [scrollRef, onUpdateEvent, draft, draggingId]);

    const onBackgroundPointerDown = useCallback((e: React.PointerEvent) => {
        setSelectedId(null);
        setEditingId(null);
        setDraft(null);
    }, []);

    return {
        draggingId,
        selectedId,
        setSelectedId,
        draft,
        setDraft,
        editingId,
        setEditingId,
        onPointerDown,
        onBackgroundPointerDown
    };
}
