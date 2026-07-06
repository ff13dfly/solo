import React, { useState, useEffect, useCallback } from 'react';
import { AgendaEvent, calculatePosition } from './AgendaTypes';

export function useAgendaScroll(scrollRef: React.RefObject<HTMLDivElement>) {
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;

        const obs = new ResizeObserver(() => {
            setViewportHeight(el.clientHeight);
            setScrollTop(el.scrollTop);
        });
        obs.observe(el);

        const handleScrollEvent = () => setScrollTop(el.scrollTop);
        el.addEventListener('scroll', handleScrollEvent, { passive: true });

        // Initial values
        setScrollTop(el.scrollTop);
        setViewportHeight(el.clientHeight);

        return () => {
            obs.disconnect();
            el.removeEventListener('scroll', handleScrollEvent);
        };
    }, [scrollRef]);

    const scrollToEvent = useCallback((eventList: AgendaEvent[], direction: 'up' | 'down') => {
        if (eventList.length > 0 && scrollRef.current) {
            const sorted = [...eventList].sort((a, b) => calculatePosition(a.startTime!) - calculatePosition(b.startTime!));
            const target = direction === 'up' ? sorted[sorted.length - 1] : sorted[0];
            const top = calculatePosition(target.startTime!);
            scrollRef.current.scrollTo({ top: top - 100, behavior: 'smooth' });
        }
    }, [scrollRef]);

    return {
        scrollTop,
        viewportHeight,
        scrollToEvent
    };
}
