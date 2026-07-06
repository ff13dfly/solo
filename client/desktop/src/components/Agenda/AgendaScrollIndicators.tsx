import React from "react";
import { motion } from "framer-motion";
import { AgendaEvent, calculatePosition } from "./AgendaTypes";

interface AgendaScrollIndicatorsProps {
    events: AgendaEvent[];
    scrollTop: number;
    viewportHeight: number;
    scrollToEvent?: (events: AgendaEvent[], direction: 'up' | 'down') => void;
    topOffset?: number; // Offset for sticky top (e.g. 0 for DayView, 56 for WeekView if header is in same scroll)
    gridOffset?: number; // Offset for calculation (e.g. 20 for TimeGrid padding)
}

export const AgendaScrollIndicators: React.FC<AgendaScrollIndicatorsProps> = ({
    events,
    scrollTop,
    viewportHeight,
    scrollToEvent,
    topOffset = 0,
    gridOffset = 20
}) => {
    const gridVisibleTop = scrollTop - gridOffset;
    const gridVisibleBottom = gridVisibleTop + viewportHeight;

    // Use detection buffer for stability
    const hasAbove = events.some(ev => calculatePosition(ev.startTime!) < gridVisibleTop - 100);
    const hasBelow = events.some(ev => calculatePosition(ev.startTime!) > gridVisibleBottom + 100);

    return (
        <div className="absolute inset-0 pointer-events-none z-20 flex flex-col">
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
                style={{ top: topOffset, pointerEvents: hasAbove ? 'auto' : 'none' }}
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
        </div>
    );
};
