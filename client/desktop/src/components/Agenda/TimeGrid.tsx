import React from "react";
import { HOURS, HOUR_HEIGHT } from "./AgendaTypes";

interface TimeGridProps {
    children?: React.ReactNode;
    columns?: number;
    showLabels?: boolean;
    showLines?: boolean;
    showColumns?: boolean;
    labelWidth?: number;
}

export const GRID_TOP_PADDING = 20;

export function TimeGrid({
    children,
    columns = 1,
    showLabels = true,
    showLines = true,
    showColumns = true,
    labelWidth = 64
}: TimeGridProps) {
    return (
        <div
            className="relative min-w-full"
            style={{ height: HOURS.length * HOUR_HEIGHT + 40 + GRID_TOP_PADDING }}
        >
            {/* Horizontal Grid Lines & Hour Labels */}
            {HOURS.map((hour) => {
                const isOffHours = hour < 7 || hour >= 21;
                return (
                    <div key={hour} className="absolute w-full flex items-start" style={{ top: hour * HOUR_HEIGHT + GRID_TOP_PADDING, height: HOUR_HEIGHT }}>
                        {showLabels && (
                            <div
                                className="flex-shrink-0 -translate-y-1/2 px-3 text-[10px] font-medium text-[#86868b] text-right"
                                style={{ width: labelWidth }}
                            >
                                {hour.toString().padStart(2, '0')}:00
                            </div>
                        )}
                        {showLines && (
                            <div className={`flex-1 border-t border-[#f2f2f7] h-full ${isOffHours ? 'bg-[#f8f8fa]' : ''}`} style={{ marginLeft: !showLabels ? labelWidth : 0 }}></div>
                        )}
                    </div>
                );
            })}

            {/* Final Closing Line (24:00 / 0:00) */}
            <div className="absolute w-full flex items-start" style={{ top: 24 * HOUR_HEIGHT + GRID_TOP_PADDING }}>
                {showLabels && (
                    <div
                        className="flex-shrink-0 -translate-y-1/2 px-3 text-[10px] font-medium text-[#86868b] text-right"
                        style={{ width: labelWidth }}
                    >
                        00:00
                    </div>
                )}
                {showLines && (
                    <div className={`flex-1 border-t border-[#f2f2f7] border-l border-[#f2f2f7]`} style={{ marginLeft: !showLabels ? labelWidth : 0 }}></div>
                )}
            </div>

            {/* Multi-column Vertical Lines (for Week View) */}
            {showColumns && columns > 1 && (
                <div className="absolute top-0 bottom-0 right-0 flex pointer-events-none" style={{ left: labelWidth, paddingTop: GRID_TOP_PADDING }}>
                    {Array.from({ length: columns }).map((_, i) => (
                        <div key={i} className="flex-1 border-r border-[#f2f2f7]"></div>
                    ))}
                </div>
            )}

            {/* Content Area */}
            <div className="absolute right-0 h-full" style={{ left: labelWidth, top: GRID_TOP_PADDING }}>
                {children}
            </div>
        </div>
    );
}
