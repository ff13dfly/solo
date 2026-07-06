export interface AgendaEvent {
    id: string;
    title: string;
    startTime: number; // Unix timestamp (ms)
    endTime: number;   // Unix timestamp (ms)
    date: string;      // "YYYY-MM-DD"
    ext?: {
        todoId?: string;
        color?: string; // Manual override
        [key: string]: any;
    };
}

export type ViewType = "日" | "周" | "月" | "年";

export const HOURS = Array.from({ length: 24 }, (_, i) => i);
export const HOUR_HEIGHT = 80;
export const MONTH_WEEKS = Array.from({ length: 5 }, (_, i) => i);

export const PRESET_COLORS = [
    "#0071e3", // Apple Blue
    "#34c759", // Apple Green
    "#ff3b30", // Apple Red
];

/**
 * Calculates pixel position relative to the start of the day.
 * @param time Unix timestamp (ms) or legacy "HH:mm" string
 * @param baseDate Optional specific date to calculate relative to. If null, 00:00:00 of time's day is used.
 */
export const calculatePosition = (time: number | string, baseDate?: string) => {
    if (time === undefined || time === null) return 0;

    // Handle string (legacy HH:mm)
    if (typeof time === "string" && time.includes(":")) {
        const parts = time.split(":").map(Number);
        if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return 0;
        const [h, m] = parts;
        return h * HOUR_HEIGHT + (m / 60) * HOUR_HEIGHT;
    }

    const t = Number(time);
    if (isNaN(t)) return 0;

    // Calculate offset from start of day
    const date = new Date(t);
    const h = date.getHours();
    const m = date.getMinutes();
    const s = date.getSeconds();

    return h * HOUR_HEIGHT + (m / 60) * HOUR_HEIGHT + (s / 3600) * HOUR_HEIGHT;
};

export const formatTime = (time: number | string) => {
    if (typeof time === "string") return time; // Legacy
    const date = new Date(time);
    const h = date.getHours();
    const m = date.getMinutes();
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
};

export const roundToInterval = (value: number, interval: number) => {
    return Math.round(value / interval) * interval;
};
