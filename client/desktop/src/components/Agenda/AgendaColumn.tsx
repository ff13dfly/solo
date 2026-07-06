import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AgendaEvent, calculatePosition } from "./AgendaTypes";
import { PlannerTodo } from "../Todo/useTodoSync";
import { TimeGrid } from "./TimeGrid";
import { AgendaEventCard } from "./AgendaEventCard";

export interface AgendaColumnProps {
    date: Date;
    dateStr: string;
    events: AgendaEvent[];
    todos: PlannerTodo[];
    nowPosition: number;
    isToday: boolean;
    // Unified interaction object from useAgendaController
    interaction: any;
    scrollTop?: number;
    viewportHeight?: number;
    scrollToEvent?: (events: AgendaEvent[], direction: 'up' | 'down') => void;
    hideHeader?: boolean;
}

export const AgendaDayContent: React.FC<AgendaColumnProps> = ({
    date,
    dateStr,
    events,
    todos,
    nowPosition,
    isToday,
    interaction,
    scrollTop = 0,
    viewportHeight = 0,
    scrollToEvent,
    hideHeader = false,
}) => {
    const {
        draggingId,
        selectedId,
        editingId,
        draft,
        onPointerDown,
        onDoubleClick,
        onEdit,
        onTitleChange,
        onUpdateEvent,
        onKeyDown,
        onBlur,
        onColorClick,
        onTodoClick
    } = interaction;
    return (
        <div
            className="absolute inset-0 flex flex-col pointer-events-auto mt-[-2px] mb-[-2px]"
            data-grid-content="true"
            data-date={dateStr}
            onClick={(e) => {
                e.stopPropagation();
            }}
            onPointerDown={(e) => {
                e.stopPropagation();
                interaction.onBackgroundPointerDown(e);
            }}
            onMouseDown={(e) => {
                e.stopPropagation();
            }}
            onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onDoubleClick(e, dateStr);
            }}
        >
            <div className="flex-1 relative pointer-events-auto w-full h-full">
                {events.map((event) => {
                    const isDragging = draggingId === event.id;
                    const isEditing = editingId === event.id;
                    const isSelected = selectedId === event.id;
                    const hasActiveDraft = draft && draft.id === event.id;

                    const displayEvent = (isEditing || isDragging || hasActiveDraft)
                        ? { ...event, ...draft }
                        : event;

                    const start = calculatePosition(displayEvent.startTime!);
                    const end = calculatePosition(displayEvent.endTime!);

                    return (
                        <AgendaEventCard
                            key={event.id}
                            event={displayEvent as AgendaEvent}
                            isEditing={isEditing}
                            isSelected={isSelected}
                            top={start}
                            height={end - start}
                            todos={todos}
                            isDragging={isDragging}
                            onTitleChange={onTitleChange}
                            onUpdateEvent={onUpdateEvent}
                            onColorClick={onColorClick}
                            onTodoClick={onTodoClick}
                            onKeyDown={onKeyDown}
                            onBlur={onBlur}
                            onEdit={onEdit}
                            onPointerDown={onPointerDown}
                        />
                    );
                })}

                {/* New Event Draft */}
                {draft && editingId?.startsWith('draft-') && draft.date === dateStr && (
                    <AgendaEventCard
                        event={draft as any}
                        isEditing={true}
                        isSelected={true}
                        isDraft={true}
                        isDragging={true}
                        top={calculatePosition(draft.startTime!)}
                        height={calculatePosition(draft.endTime!) - calculatePosition(draft.startTime!)}
                        todos={todos}
                        onTitleChange={onTitleChange}
                        onUpdateEvent={() => { }}
                        onColorClick={onColorClick}
                        onTodoClick={onTodoClick}
                        onKeyDown={onKeyDown}
                        onBlur={onBlur}
                        onEdit={onEdit}
                        onPointerDown={onPointerDown}
                    />
                )}

                {(isToday || (interaction.activeView === "周")) && (
                    <motion.div
                        className="absolute left-0 right-0 z-10 flex items-center pointer-events-none -translate-y-1/2"
                        style={{ top: nowPosition, opacity: isToday ? 1 : 0.3 }}
                    >
                        {isToday && <div className="w-1.5 h-1.5 rounded-full bg-red-500 -ml-0.5 shadow-sm shadow-red-500/50"></div>}
                        <div className="flex-1 h-[2px] bg-red-500/50"></div>
                    </motion.div>
                )}
            </div>

            {/* Localized Scroll Indicators */}
            <div className="absolute inset-0 pointer-events-none z-20">
                {(() => {
                    const gridVisibleTop = scrollTop - (hideHeader ? 0 : 20);
                    const gridVisibleBottom = gridVisibleTop + viewportHeight;

                    // Use much larger buffers (100px) to compensate for state-sync latency during scroll
                    const hasAbove = events.some(ev => calculatePosition(ev.startTime!) < gridVisibleTop - 100);
                    const hasBelow = events.some(ev => calculatePosition(ev.startTime!) > gridVisibleBottom + 100);

                    return (
                        <>
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: hasAbove ? 1 : 0 }}
                                transition={{ duration: 0.2 }}
                                onClick={(e) => {
                                    if (!hasAbove) return;
                                    e.stopPropagation();
                                    const eventsByTime = [...events].sort((a, b) => calculatePosition(a.startTime!) - calculatePosition(b.startTime!));
                                    const above = eventsByTime.filter(ev => calculatePosition(ev.startTime!) < gridVisibleTop - 10);
                                    scrollToEvent?.(above, 'up');
                                }}
                                className="sticky left-0 right-0 h-1 bg-[#0071e3] shadow-[0_2px_8px_rgba(0,113,227,0.4)] cursor-pointer hover:h-1.5 transition-all pointer-events-auto z-[30]"
                                style={{ top: hideHeader ? 0 : 56, pointerEvents: hasAbove ? 'auto' : 'none' }}
                            />
                            <div className="flex-1" />
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: hasBelow ? 1 : 0 }}
                                transition={{ duration: 0.2 }}
                                onClick={(e) => {
                                    if (!hasBelow) return;
                                    e.stopPropagation();
                                    const eventsByTime = [...events].sort((a, b) => calculatePosition(a.startTime!) - calculatePosition(b.startTime!));
                                    const below = eventsByTime.filter(ev => calculatePosition(ev.startTime!) > gridVisibleBottom + 10);
                                    scrollToEvent?.(below, 'down');
                                }}
                                className="sticky bottom-0 left-0 right-0 h-1 bg-[#0071e3] shadow-[0_-2px_8px_rgba(0,113,227,0.4)] cursor-pointer hover:h-1.5 transition-all pointer-events-auto z-[30]"
                                style={{ pointerEvents: hasBelow ? 'auto' : 'none' }}
                            />
                        </>
                    );
                })()}
            </div>
        </div>
    );
};

export const AgendaColumn: React.FC<AgendaColumnProps> = (props) => {
    return (
        <TimeGrid showLabels={false} showLines={true} columns={1} labelWidth={0}>
            <AgendaDayContent {...props} />
        </TimeGrid>
    );
};
