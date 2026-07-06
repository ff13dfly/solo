import { GRID_TOP_PADDING } from "./TimeGrid";
import { HOUR_HEIGHT } from "./AgendaTypes";

export const getMonday = (d: Date) => {
    const date = new Date(d);
    if (isNaN(date.getTime())) return new Date();
    const day = date.getDay();
    const diff = date.getDate() - (day === 0 ? 6 : day - 1);
    date.setDate(diff);
    date.setHours(0, 0, 0, 0);
    return date;
};

export const dateToScrollLeft = (date: Date, vWidth: number, anchor: Date): number => {
    const dayWidth = vWidth / 7;
    const daysFromAnchor = Math.round((date.getTime() - anchor.getTime()) / (24 * 60 * 60 * 1000));
    const datePosition = 2 * vWidth + daysFromAnchor * dayWidth;
    return datePosition - vWidth / 2;
};

export const scrollLeftToDate = (scrollLeft: number, vWidth: number, anchor: Date): Date => {
    const dayWidth = vWidth / 7;
    const viewportCenterX = scrollLeft + vWidth / 2;
    const centerWeekStartX = 2 * vWidth;
    const daysFromAnchor = Math.round((viewportCenterX - centerWeekStartX) / dayWidth);
    const result = new Date(anchor);
    result.setDate(anchor.getDate() + daysFromAnchor);
    return result;
};

export const getDefaultScrollTop = (now: Date, elHeight: number): number => {
    const hour = now.getHours();
    if (hour < 13) return 6.5 * HOUR_HEIGHT + GRID_TOP_PADDING;
    if (hour < 18) return 10.5 * HOUR_HEIGHT + GRID_TOP_PADDING;
    return elHeight; // Scroll toward end of day if evening
};
