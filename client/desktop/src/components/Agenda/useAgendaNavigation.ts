import { useState, useRef, useCallback } from 'react';
import { ViewType } from './AgendaTypes';
import { addDays, addMonths, addYears, clearTime } from './DateUtils';

export function useAgendaNavigation() {
    const [activeView, setActiveView] = useState<ViewType>("日");
    const [viewDate, setViewDate] = useState(new Date());
    const [selectedDate, setSelectedDate] = useState(new Date());

    const handleSetActiveView = useCallback((newView: ViewType) => {
        setActiveView(newView);

        // When switching views, ensure we focus on the selected date
        // independent of where the previous view was scrolled to.
        setViewDate(selectedDate);
    }, [selectedDate]);

    const handleNavigate = useCallback((direction: 'prev' | 'next') => {
        const factor = direction === 'next' ? 1 : -1;

        setViewDate(prev => {
            let next: Date;
            switch (activeView) {
                case '日':
                    next = addDays(prev, factor);
                    break;
                case '周':
                    next = addDays(prev, factor * 7);
                    break;
                case '月':
                    next = addMonths(prev, factor);
                    break;
                case '年':
                    next = addYears(prev, factor);
                    break;
                default:
                    next = addDays(prev, factor);
                    break;
            }
            return next; // add* functions already return clearTime
        });
    }, [activeView]);

    const handleSetSelectedDate = useCallback((date: Date) => {
        const newDate = clearTime(date);
        setSelectedDate(newDate);
        // If we are in day view, selecting a date should also change the view to that date
        // For other views (e.g. month), we might want to just select it without jumping
        // But generally, syncing viewDate to selection is desired behavior for "Go To Date"
        setViewDate(newDate);
    }, []);

    const handleScrollToToday = useCallback((callback?: () => void) => {
        const today = clearTime(new Date());
        setViewDate(today);
        setSelectedDate(today);
        if (callback) callback();
    }, []);

    return {
        activeView,
        setActiveView: handleSetActiveView,
        viewDate,
        setViewDate,
        selectedDate,
        setSelectedDate,
        handleNavigate,
        handleScrollToToday
    };
}
