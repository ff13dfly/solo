import React, { useRef, useLayoutEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AgendaEvent, calculatePosition } from "../AgendaTypes";
import { PlannerTodo } from "../../Todo/useTodoSync";
import { useI18n } from "../../../i18n/I18nProvider";
import { TimeGrid } from "../TimeGrid";
import { useAgendaScroll } from "../useAgendaScroll";
import { AgendaDayContent } from "../AgendaColumn";
import { AgendaEventCard } from "../AgendaEventCard";

// Refactored Utilities and Hooks
import { useWeekViewWindows } from "../hooks/useWeekViewWindows";
import { useWeekViewScroll } from "../hooks/useWeekViewScroll";

interface WeekViewProps {
  events: AgendaEvent[];
  todos: PlannerTodo[];
  now: Date;
  viewDate: Date;
  nowPosition: number;
  scrollRef: React.RefObject<HTMLDivElement>;
  interaction: any;
  selectedDate?: Date;
  hideLabels?: boolean;
  hideHeader?: boolean;
}

export default function WeekView({
  events,
  todos,
  now,
  viewDate,
  nowPosition,
  scrollRef,
  interaction,
  hideLabels = false,
  hideHeader = false,
}: WeekViewProps) {
  const { t } = useI18n();
  const weekdays = t("agenda.weekdays");

  const [viewportWidth, setViewportWidth] = React.useState(0);
  const verticalAxisRef = useRef<HTMLDivElement>(null);

  // Measure Viewport
  useLayoutEffect(() => {
    const updateWidth = () => {
      if (scrollRef.current) setViewportWidth(scrollRef.current.clientWidth);
    };
    updateWidth();
    const obs = new ResizeObserver(updateWidth);
    if (scrollRef.current) obs.observe(scrollRef.current);
    return () => obs.disconnect();
  }, [scrollRef]);

  // 1. Data Logic (Sliding Windows)
  const { centerDate, setCenterDate, anchorMonday, slidingWindows } = useWeekViewWindows({ viewDate, now });

  // 2. Physics Logic (Scroll, Snapping, Compensation)
  const { handleScroll } = useWeekViewScroll({
    scrollRef,
    viewportWidth,
    anchorMonday,
    centerDate,
    setCenterDate,
    viewDate,
    setViewDate: interaction.setViewDate,
    now,
    interaction
  });

  // 3. UI Helpers
  const { scrollToEvent, scrollTop, viewportHeight } = useAgendaScroll(scrollRef);

  // Sync vertical labels scroll
  const onMainScroll = (e: React.UIEvent<HTMLDivElement>) => {
    handleScroll(e);
    if (verticalAxisRef.current) verticalAxisRef.current.scrollTop = e.currentTarget.scrollTop;
  };

  return (
    <div
      className="h-full bg-white relative flex overflow-hidden"
      onPointerDown={(e) => {
        const target = e.target as HTMLElement;
        if (!target.closest("button, .popover-content, [data-agenda-event], [data-grid-content]")) {
          interaction.onBackgroundPointerDown(e);
        }
      }}
    >
      {!hideLabels && (
        <div className="w-16 bg-white border-r border-[#f2f2f7] h-full flex flex-col flex-shrink-0 z-50">
          {!hideHeader && <div className="h-14 bg-[#fbfbfd] border-b border-[#f2f2f7]" />}
          <div className="flex-1 overflow-hidden pointer-events-none" ref={verticalAxisRef}>
            <TimeGrid showLabels={true} showLines={false} showColumns={false} />
          </div>
        </div>
      )}

      <div className="flex-1 relative flex flex-col overflow-hidden bg-[#fbfbfd]">
        <div
          className="flex-1 overflow-auto relative no-scrollbar"
          ref={scrollRef}
          onScroll={onMainScroll}
          style={{ overscrollBehaviorX: "contain" }}
        >
          <div className="flex min-h-full w-max">
            <div className="flex">
              {slidingWindows.map((window) => (
                <div key={window.offset} className="flex flex-col" style={{ width: viewportWidth || "100%" }}>
                  {!hideHeader && (
                    <div className="sticky top-0 z-40 flex h-14 border-b border-[#f2f2f7] bg-[#fbfbfd] items-center">
                      {window.dates.map((dateInfo, idx) => (
                        <div
                          key={idx}
                          onClick={() => interaction.handleDateSelect?.(dateInfo.originalDate)}
                          className="flex-1 min-w-[120px] text-center border-l border-[#f2f2f7] first:border-l-0 flex items-baseline justify-center gap-1.5 shadow-[0.5px_0_0_0_#f2f2f7] cursor-pointer hover:bg-[#f2f2f7]/30 transition-colors"
                        >
                          <span className={`text-xl font-semibold ${dateInfo.isToday ? "text-[#0071e3]" : "text-[#1d1d1f]"}`}>
                            {dateInfo.day}
                          </span>
                          <span className="text-[10px] font-bold text-[#86868b] uppercase">
                            {weekdays[idx]}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="relative flex-1">
                    <TimeGrid showLabels={false} showLines={true} columns={7} labelWidth={0}>
                      <div className="absolute inset-x-0 top-0 h-full flex pointer-events-none">
                        {window.dates.map((dateInfo, idx) => (
                          <div key={idx} data-date={dateInfo.full} className="flex-1 relative pointer-events-auto" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
                            <AgendaDayContent
                              date={new Date(dateInfo.full)}
                              dateStr={dateInfo.full}
                              events={events.filter((e) => e.date === dateInfo.full)}
                              todos={todos}
                              nowPosition={nowPosition}
                              isToday={dateInfo.isToday}
                              interaction={interaction}
                              scrollTop={scrollTop}
                              viewportHeight={viewportHeight}
                              scrollToEvent={scrollToEvent}
                              hideHeader={hideHeader}
                            />
                          </div>
                        ))}

                        {/* Drag Ghost Overlay - Stable in the window's DOM */}
                        {interaction.draggingId && interaction.draft && (
                          <div className="absolute inset-0 z-50 pointer-events-none">
                            {window.dates.map((dateInfo, idx) => {
                              if (dateInfo.full !== interaction.draft.date) return null;

                              const start = calculatePosition(interaction.draft.startTime!);
                              const end = calculatePosition(interaction.draft.endTime!);

                              return (
                                <div key="ghost" className="absolute top-0 bottom-0" style={{ left: `${(idx / 7) * 100}%`, width: `${100 / 7}%` }}>
                                  <AgendaEventCard
                                    event={interaction.draft as AgendaEvent}
                                    isEditing={false}
                                    isSelected={true}
                                    isDragging={false} // Ghost should be visible
                                    top={start}
                                    height={end - start}
                                    todos={todos}
                                    onTitleChange={() => { }}
                                    onUpdateEvent={() => { }}
                                    onColorClick={() => { }}
                                    onTodoClick={() => { }}
                                    onKeyDown={() => { }}
                                    onBlur={() => { }}
                                    onEdit={() => { }}
                                    onPointerDown={() => { }}
                                  />
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </TimeGrid>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Scroll Indicators (Now localized in AgendaDayContent) */}
      </div>
    </div>
  );
}
