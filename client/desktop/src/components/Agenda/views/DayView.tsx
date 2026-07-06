import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, useDragControls } from "framer-motion";
import { AgendaEvent, HOUR_HEIGHT, calculatePosition, formatTime } from "../AgendaTypes";
import { PlannerTodo } from "../../Todo/useTodoSync";
import { TimeGrid, GRID_TOP_PADDING } from "../TimeGrid";
import { useAgendaScroll } from "../useAgendaScroll";
import { AgendaColumn } from "../AgendaColumn";
import { formatDate, isSameDay } from "../DateUtils";

interface DayViewProps {
    events: AgendaEvent[];
    todos: PlannerTodo[];
    now: Date;
    viewDate: Date;
    nowPosition: number;
    scrollRef: React.RefObject<HTMLDivElement>;
    interaction: {
        now: Date;
        nowPosition: number;
        [key: string]: any;
    };
    selectedDate?: Date;
    hideLabels?: boolean;
    hideHeader?: boolean;
    externalScrollTop?: number;
}

export default function DayView({
    events, todos, now, viewDate, nowPosition, scrollRef, interaction,
    hideLabels = false,
    hideHeader = false,
    externalScrollTop,
}: DayViewProps) {
    // Direction tracking for carousel animation
    const [direction, setDirection] = useState(0);
    const lastViewDateRef = useRef(viewDate.toDateString());
    const lastScrollTopRef = useRef(0);

    const {
        draggingId, selectedId, draft, editingId,
        onPointerDown, onBackgroundPointerDown,
        onUpdateEvent, onDeleteEvent,
        onDoubleClick, handleConfirmDraft, handleTitleChange, handleKeyDown, onEdit: handleEdit, handleUpdateConfirm,
        handleNavigate, setViewDate
    } = interaction;

    const dragControls = useDragControls();

    // Initial scroll position (Today's time)
    useEffect(() => {
        if (scrollRef.current && !lastScrollTopRef.current) {
            const hour = now.getHours();
            let targetScroll = 0;
            if (hour < 13) targetScroll = 6.5 * HOUR_HEIGHT + GRID_TOP_PADDING;
            else if (hour < 18) targetScroll = 10.5 * HOUR_HEIGHT + GRID_TOP_PADDING;
            else targetScroll = scrollRef.current.scrollHeight;

            scrollRef.current.scrollTop = targetScroll;
            lastScrollTopRef.current = targetScroll;
        }
    }, [now, scrollRef]);

    // Handle external viewDate changes
    useEffect(() => {
        const dateStr = viewDate.toDateString();
        if (dateStr !== lastViewDateRef.current) {
            const lastDate = new Date(lastViewDateRef.current);
            const diff = viewDate.getTime() - lastDate.getTime();
            setDirection(diff > 0 ? 1 : -1);
            lastViewDateRef.current = dateStr;
        }
    }, [viewDate]);

    // Scroll synchronization
    const timeAxisScrollRef = useRef<HTMLDivElement>(null);
    const prevDayScrollRef = useRef<HTMLDivElement>(null);
    const nextDayScrollRef = useRef<HTMLDivElement>(null);

    const handleVerticalScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const scrollTop = e.currentTarget.scrollTop;
        lastScrollTopRef.current = scrollTop;
        if (timeAxisScrollRef.current) timeAxisScrollRef.current.scrollTop = scrollTop;
        if (prevDayScrollRef.current) prevDayScrollRef.current.scrollTop = scrollTop;
        if (nextDayScrollRef.current) nextDayScrollRef.current.scrollTop = scrollTop;
    };

    useEffect(() => {
        const top = lastScrollTopRef.current;
        if (scrollRef.current) scrollRef.current.scrollTop = top;
        if (timeAxisScrollRef.current) timeAxisScrollRef.current.scrollTop = top;
        if (prevDayScrollRef.current) prevDayScrollRef.current.scrollTop = top;
        if (nextDayScrollRef.current) nextDayScrollRef.current.scrollTop = top;
    }, [viewDate, scrollRef]);

    const { scrollTop, viewportHeight, scrollToEvent } = useAgendaScroll(scrollRef);

    useEffect(() => {
        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            if (selectedId && !editingId) {
                if (e.key === 'Backspace' || e.key === 'Delete') {
                    const ev = events.find(e => e.id === selectedId);
                    if (ev) onDeleteEvent(ev);
                    interaction.setSelectedId(null);
                }
            }
        };
        window.addEventListener('keydown', handleGlobalKeyDown);
        return () => window.removeEventListener('keydown', handleGlobalKeyDown);
    }, [selectedId, editingId, onDeleteEvent, interaction, events]);

    const actualScrollTop = externalScrollTop ?? scrollTop;
    const isTodayPage = viewDate.toDateString() === now.toDateString();
    const viewDateStr = viewDate.toLocaleDateString("sv-SE");

    const paginate = (newDirection: number) => {
        handleNavigate(newDirection > 0 ? 'next' : 'prev');
    };

    const variants = {
        enter: (direction: number) => ({
            x: direction > 0 ? "100%" : direction < 0 ? "-100%" : 0,
            opacity: 1
        }),
        center: { x: 0, opacity: 1 },
        exit: (direction: number) => ({
            x: direction < 0 ? "100%" : direction > 0 ? "-100%" : 0,
            opacity: 1
        })
    };

    const renderDayContent = (date: Date, mode: 'main' | 'prev' | 'next') => {
        const isMain = mode === 'main';
        const dateStr = formatDate(date);
        const isToday = isSameDay(date, now);
        const dayEvents = events.filter(e => e.date === dateStr);
        const currentScrollRef = isMain ? scrollRef : (mode === 'prev' ? prevDayScrollRef : nextDayScrollRef);

        return (
            <div className="flex-1 flex flex-col bg-white overflow-hidden" data-date={dateStr}>
                {!hideHeader && (
                    <div className="flex h-14 border-b border-[#f2f2f7] bg-[#fbfbfd] items-center justify-center gap-1.5 flex-shrink-0">
                        <span className={`text-xl font-semibold ${isToday ? "text-[#0071e3]" : "text-[#1d1d1f]"}`}>
                            {date.getDate()}
                        </span>
                        <span className="text-[10px] font-bold text-[#86868b] uppercase">
                            {date.toLocaleDateString(undefined, { weekday: 'short' })}
                        </span>
                    </div>
                )}
                <div
                    className="flex-1 overflow-y-auto relative no-scrollbar"
                    ref={currentScrollRef}
                    onScroll={isMain ? handleVerticalScroll : undefined}
                    style={{ touchAction: 'pan-x pan-y' }}
                >
                    <div className="relative h-fit">
                        <AgendaColumn
                            date={date}
                            dateStr={dateStr}
                            events={events.filter((e) => {
                                if (e.id === interaction.draggingId && interaction.draft?.date) {
                                    return interaction.draft.date === dateStr;
                                }
                                return e.date === dateStr;
                            })}
                            todos={todos}
                            nowPosition={nowPosition}
                            isToday={isToday}
                            interaction={interaction}
                            scrollTop={actualScrollTop}
                            viewportHeight={viewportHeight}
                            scrollToEvent={scrollToEvent}
                            hideHeader={hideHeader}
                        />
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div className="h-full bg-white relative flex overflow-hidden select-none">
            {!hideLabels && (
                <div className="w-16 bg-white border-r border-[#f2f2f7] h-full flex flex-col flex-shrink-0 z-50">
                    {!hideHeader && <div className="h-14 bg-[#fbfbfd] border-b border-[#f2f2f7]" />}
                    <div className="flex-1 overflow-hidden pointer-events-none no-scrollbar" ref={timeAxisScrollRef}>
                        <TimeGrid showLabels={true} showLines={false} showColumns={false} />
                    </div>
                </div>
            )}

            <div
                className="flex-1 relative overflow-hidden bg-[#fbfbfd]"
                onPointerDown={(e) => {
                    // Only handle pure clicks on the background container or its Immediate children
                    if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('no-scrollbar')) {
                        onBackgroundPointerDown(e);
                    }
                }}
            >
                <AnimatePresence initial={false} custom={direction} mode="popLayout">
                    <motion.div
                        key={viewDate.toDateString()}
                        custom={direction}
                        variants={variants}
                        initial="enter" animate="center" exit="exit"
                        transition={{ x: { type: "spring", stiffness: 350, damping: 40 }, opacity: { duration: 0.2 } }}
                        // CRITICAL FIX: Disable drag gesture entirely when editing or drafting to prevent conflicts
                        drag={interaction.draft || interaction.editingId ? false : "x"}
                        dragDirectionLock
                        onDragEnd={(e, { offset, velocity }) => {
                            const swipe = Math.abs(offset.x) > 50 || Math.abs(velocity.x) > 300;
                            if (swipe) paginate(offset.x > 0 ? -1 : 1);
                        }}
                        className="absolute inset-0 flex bg-white z-10"
                        style={{ touchAction: 'pan-x pan-y' }}
                    >
                        <div className="absolute top-0 bottom-0 right-full w-full opacity-60 pointer-events-none border-r border-[#f2f2f7]">
                            {(() => {
                                const d = new Date(viewDate);
                                d.setDate(d.getDate() - 1);
                                return renderDayContent(d, 'prev');
                            })()}
                        </div>
                        {renderDayContent(viewDate, 'main')}
                        <div className="absolute top-0 bottom-0 left-full w-full opacity-60 pointer-events-none border-l border-[#f2f2f7]">
                            {(() => {
                                const d = new Date(viewDate);
                                d.setDate(d.getDate() + 1);
                                return renderDayContent(d, 'next');
                            })()}
                        </div>
                    </motion.div>
                </AnimatePresence>

                <AnimatePresence>
                    {draggingId && draft && (
                        <motion.div
                            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                            className="absolute left-0 right-0 z-[60] pointer-events-none flex items-center"
                            style={{
                                top: calculatePosition(draft.startTime!) - (lastScrollTopRef.current || 0) + (hideHeader ? 0 : 56) + GRID_TOP_PADDING,
                                marginLeft: hideLabels ? 0 : 64
                            }}
                        >
                            <div className="flex-1 h-[1.5px] border-t-2 border-dashed border-[#0071e3] opacity-60 shadow-sm"></div>
                            <div className="bg-[#0071e3] text-white text-[10px] font-black px-1.5 py-0.5 rounded-sm mr-4 shadow-lg flex items-center gap-1">
                                <span className="opacity-80 truncate max-w-[120px]">{draft.title || "Event"}</span>
                                <span className="border-l border-white/40 pl-1.5 ml-0.5">{formatTime(draft.startTime!)}</span>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Scroll Indicators (Now localized in AgendaColumn) */}
            </div>
        </div>
    );
}
