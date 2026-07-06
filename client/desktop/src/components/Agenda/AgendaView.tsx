import React, { useState, useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AgendaEvent, HOUR_HEIGHT } from "./AgendaTypes";
import AgendaHeader from "./AgendaHeader";
import DayView from "./views/DayView";
import WeekView from "./views/WeekView";
import MonthView from "./views/MonthView";
import YearView from "./views/YearView";
import AgendaTodoSidebar from "./AgendaTodoSidebar";
import { useAgendaSync } from "./useAgendaSync";
import { useTodoSync } from "../Todo/useTodoSync";
import { useAgendaController } from "./useAgendaController";
import { ColorPicker } from "./ColorPicker";
import { TodoMentionSelector } from "./TodoMentionSelector";
import { useEventPopovers } from "./useEventPopovers";

export default function AgendaView() {
    const [showTodoSidebar, setShowTodoSidebar] = useState(true);
    const [todayTrigger, setTodayTrigger] = useState(0);

    const { events, addEvent, updateEvent, deleteEvent, setEvents } = useAgendaSync();
    const { todos, updateTodo } = useTodoSync((idMap) => {
        setEvents((prev: AgendaEvent[]) => prev.map(ev => {
            if (ev.ext?.todoId && idMap[ev.ext.todoId]) {
                return {
                    ...ev,
                    ext: { ...ev.ext, todoId: idMap[ev.ext.todoId] }
                };
            }
            return ev;
        }));
    });

    const [now, setNow] = useState(new Date());
    const scrollRef = useRef<HTMLDivElement>(null);

    const popoversState = useEventPopovers();
    const { colorPickerAnchor, setColorPickerAnchor, todoPickerAnchor, setTodoPickerAnchor, mentionSearch, mentionAnchor } = popoversState;

    const controller = useAgendaController({
        events,
        todos,
        onAddEvent: addEvent,
        onUpdateEvent: updateEvent as any,
        onDeleteEvent: deleteEvent,
        scrollRef,
        now,
        popovers: {
            openColorPicker: popoversState.openColorPicker,
            openTodoPicker: popoversState.openTodoPicker,
            closePickers: popoversState.closePickers,
            mentionSearch: popoversState.mentionSearch,
            handleTitleChangeForMentions: popoversState.handleTitleChangeForMentions,
            setMentionSearch: popoversState.setMentionSearch
        }
    });

    const { interaction } = controller;

    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 60000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        if (interaction.activeView === "周") {
            setShowTodoSidebar(false);
        } else {
            setShowTodoSidebar(true);
        }
    }, [interaction.activeView]);

    const onScrollToToday = () => {
        interaction.handleScrollToToday(() => {
            setTodayTrigger(prev => prev + 1);
            if (scrollRef.current) {
                const nowPosition = interaction.nowPosition;
                scrollRef.current.scrollTo({ top: nowPosition + 20 - 200, behavior: 'smooth' });
            }
        });
    };

    return (
        <div className="flex-1 flex flex-col h-full overflow-hidden bg-white select-none relative">
            <AgendaHeader
                now={now}
                viewDate={interaction.viewDate}
                activeView={interaction.activeView}
                setActiveView={interaction.setActiveView}
                onScrollToToday={onScrollToToday}
                onNavigate={interaction.handleNavigate}
            />

            <div className="flex-1 flex flex-row overflow-hidden relative">
                <main className="flex-1 relative overflow-hidden h-full">
                    <AnimatePresence mode="wait">
                        {interaction.activeView === "日" && (
                            <motion.div
                                key="day-view-wrapper"
                                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                                className="h-full w-full"
                            >
                                <DayView
                                    events={events}
                                    todos={todos}
                                    now={now}
                                    viewDate={interaction.selectedDate}
                                    nowPosition={interaction.nowPosition}
                                    scrollRef={scrollRef}
                                    interaction={interaction}
                                    selectedDate={interaction.selectedDate}
                                />
                            </motion.div>
                        )}
                        {interaction.activeView === "周" && (
                            <motion.div
                                key="week-view-wrapper"
                                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                                className="h-full w-full"
                            >
                                <WeekView
                                    events={events}
                                    todos={todos}
                                    now={now}
                                    viewDate={interaction.viewDate}
                                    nowPosition={interaction.nowPosition}
                                    scrollRef={scrollRef}
                                    interaction={interaction}
                                    selectedDate={interaction.selectedDate}
                                />
                            </motion.div>
                        )}
                        {interaction.activeView === "月" && (
                            <motion.div
                                key="month-view-wrapper"
                                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                                className="h-full w-full"
                            >
                                <MonthView
                                    now={now}
                                    viewDate={interaction.viewDate}
                                    onSelectDate={interaction.handleDateSelect}
                                    todayTrigger={todayTrigger}
                                />
                            </motion.div>
                        )}
                        {interaction.activeView === "年" && (
                            <motion.div
                                key="year-view-wrapper"
                                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                                className="h-full w-full"
                            >
                                <YearView
                                    now={now}
                                    viewDate={interaction.viewDate}
                                    onSelectDate={interaction.handleDateSelect}
                                    todayTrigger={todayTrigger}
                                />
                            </motion.div>
                        )}
                    </AnimatePresence>
                </main>

                <AgendaTodoSidebar
                    isOpen={showTodoSidebar}
                    activeView={interaction.activeView}
                    events={events}
                    todos={todos}
                    updateTodo={updateTodo}
                    onToggle={() => setShowTodoSidebar(!showTodoSidebar)}
                />
            </div>

            {/* Global Popovers */}
            <AnimatePresence>
                {colorPickerAnchor && (() => {
                    const anchor = colorPickerAnchor;
                    const event = events.find((e) => e.id === anchor.targetId);
                    const isDraft = interaction.draft?.id === anchor.targetId;
                    const color = (isDraft ? interaction.draft?.ext?.color : event?.ext?.color) || "";
                    const todoId = isDraft ? interaction.draft?.ext?.todoId : event?.ext?.todoId;
                    const todoColor = todos.find((t) => t.id === todoId)?.ext?.color;
                    return (
                        <ColorPicker
                            currentColor={color}
                            todoColor={todoColor}
                            anchorRect={anchor.rect}
                            onClose={() => setColorPickerAnchor(null)}
                            onSelect={(color) => {
                                if (interaction.draft && interaction.draft.id === anchor.targetId) {
                                    interaction.setDraft((prev: any) => ({ ...prev, ext: { ...(prev?.ext || {}), color: color === null ? undefined : color } }));
                                }
                                if (anchor.targetId && !anchor.targetId.startsWith("draft-")) {
                                    const event = events.find((e) => e.id === anchor.targetId);
                                    if (event) interaction.onUpdateEvent({ ...event, ext: { ...(event.ext || {}), color: color === null ? undefined : color } });
                                }
                                setColorPickerAnchor(null);
                            }}
                        />
                    );
                })()}

                {todoPickerAnchor && (
                    <TodoMentionSelector
                        todos={todos}
                        searchTerm=""
                        showClear={true}
                        anchorRect={todoPickerAnchor.rect}
                        maxRight={interaction.activeView === "日" ? (showTodoSidebar ? 400 : window.innerWidth - 56) : (window.innerWidth - 320)}
                        onClose={() => setTodoPickerAnchor(null)}
                        onSelect={(todo) => {
                            if (interaction.draft && interaction.draft.id === todoPickerAnchor.targetId) {
                                interaction.setDraft((prev: any) => ({ ...prev, ext: { ...(prev?.ext || {}), todoId: todo?.id || undefined, color: undefined } }));
                            }
                            const anchor = todoPickerAnchor;
                            if (anchor?.targetId && !anchor.targetId.startsWith("draft-")) {
                                const event = events.find((e) => e.id === anchor.targetId);
                                if (event) interaction.onUpdateEvent({ ...event, ext: { ...(event.ext || {}), todoId: todo?.id || undefined, color: undefined } });
                            }
                            setTodoPickerAnchor(null);
                        }}
                    />
                )}

                {(mentionSearch !== null && mentionAnchor) && (
                    <TodoMentionSelector
                        todos={todos}
                        searchTerm={mentionSearch}
                        showClear={false}
                        anchorRect={mentionAnchor}
                        maxRight={interaction.activeView === "日" ? (showTodoSidebar ? 400 : window.innerWidth - 56) : (window.innerWidth - 320)}
                        onClose={() => popoversState.setMentionSearch(null)}
                        onSelect={(todo) => {
                            if (!todo) {
                                popoversState.setMentionSearch(null);
                                return;
                            }

                            const targetId = interaction.editingId;
                            if (!targetId) {
                                popoversState.setMentionSearch(null);
                                return;
                            }

                            const targetEvent = events.find(e => e.id === targetId) || (interaction.draft?.id === targetId ? interaction.draft : null);
                            if (!targetEvent) {
                                popoversState.setMentionSearch(null);
                                return;
                            }

                            const currentTitle = targetEvent.title || "";
                            const lastHashIndex = currentTitle.lastIndexOf('#');
                            const baseTitle = lastHashIndex !== -1 ? currentTitle.slice(0, lastHashIndex).trim() : currentTitle;
                            const newTitle = baseTitle;

                            const ext = { ...((targetEvent as any).ext || {}), todoId: todo.id, color: undefined };

                            if (targetId.startsWith('draft-')) {
                                interaction.setDraft((prev: any) => ({ ...prev, title: newTitle, ext }));
                            } else {
                                const fullEvent = events.find(e => e.id === targetId);
                                if (fullEvent) {
                                    const updated = { ...fullEvent, title: newTitle, ext };
                                    interaction.onUpdateEvent(updated);
                                    interaction.setDraft(updated);
                                }
                            }
                            popoversState.setMentionSearch(null);
                        }}
                    />
                )}
            </AnimatePresence>
        </div>
    );
}
