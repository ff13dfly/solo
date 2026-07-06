/**
 * Safe date manipulation utilities
 * 
 * DESIGN PRINCIPLES:
 * 1. Local Time Only: All functions operate on local time. No UTC conversions.
 * 2. Safe Arithmetic: Handles month/year overflows correctly (e.g., Jan 31 -> Feb 28).
 * 3. Time Clearing: Ensures dates are compared/stored effectively as "Day" objects (00:00:00).
 */

export const formatDate = (date: Date): string => {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
};

export const parseDate = (str: string): Date => {
    const [year, month, day] = str.split('-').map(Number);
    return new Date(year, month - 1, day, 0, 0, 0, 0);
};

export const clearTime = (date: Date): Date => {
    const result = new Date(date);
    result.setHours(0, 0, 0, 0);
    return result;
};

export const addDays = (date: Date, days: number): Date => {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return clearTime(result);
};

export const addMonths = (date: Date, months: number): Date => {
    const result = new Date(date);
    const d = result.getDate();
    result.setMonth(result.getMonth() + months);
    if (result.getDate() !== d) {
        result.setDate(0);
    }
    return clearTime(result);
};

export const addYears = (date: Date, years: number): Date => {
    const result = new Date(date);
    const d = result.getDate();
    const m = result.getMonth();
    result.setFullYear(result.getFullYear() + years);
    // Handle leap year case: Feb 29 -> Feb 28 if target year isn't leap
    if (result.getMonth() !== m) {
        result.setDate(0);
    }
    return clearTime(result);
};

export const isSameDay = (d1: Date, d2: Date): boolean => {
    return d1.getFullYear() === d2.getFullYear() &&
        d1.getMonth() === d2.getMonth() &&
        d1.getDate() === d2.getDate();
};

export const isSameMonth = (d1: Date, d2: Date): boolean => {
    return d1.getFullYear() === d2.getFullYear() &&
        d1.getMonth() === d2.getMonth();
};

export const isSameYear = (d1: Date, d2: Date): boolean => {
    return d1.getFullYear() === d2.getFullYear();
};
