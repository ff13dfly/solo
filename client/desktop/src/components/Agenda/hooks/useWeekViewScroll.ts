import { useRef, useLayoutEffect, useCallback, useEffect } from "react";
import { dateToScrollLeft, scrollLeftToDate, getDefaultScrollTop, getMonday } from "../AgendaUtils";

interface UseWeekViewScrollProps {
    scrollRef: React.RefObject<HTMLDivElement>;
    viewportWidth: number;
    anchorMonday: Date;
    centerDate: Date;
    setCenterDate: (d: Date) => void;
    viewDate: Date;
    setViewDate: (d: Date) => void;
    now: Date;
    interaction: any;
}

export function useWeekViewScroll({
    scrollRef,
    viewportWidth,
    anchorMonday,
    centerDate,
    setCenterDate,
    viewDate,
    setViewDate,
    now,
    interaction
}: UseWeekViewScrollProps) {
    const isProgrammaticScrollRef = useRef(false);
    const lastProgrammaticScrollRef = useRef(0);
    const lastMondayRef = useRef<string>("");
    const scrollTimerRef = useRef<any>(null);
    const isSystemScrollRef = useRef(false);
    const animationFrameRef = useRef<number>(0);
    const settleTimeoutRef = useRef<any>(null);
    const lastScrollXRef = useRef<number>(0);
    const lastDirectionRef = useRef<number>(0);
    const viewportWidthRef = useRef(viewportWidth);

    useEffect(() => {
        viewportWidthRef.current = viewportWidth;
    }, [viewportWidth]);

    // ===== Snapping & Settlement =====
    const performSettlement = useCallback((currentLeft: number) => {
        const vWidth = viewportWidthRef.current;
        if (vWidth <= 0 || isSystemScrollRef.current) return;
        if (interaction.draft || interaction.editingId) return;

        const dayWidth = vWidth / 7;
        let targetDayIndex: number;
        if (lastDirectionRef.current > 0) targetDayIndex = Math.ceil(currentLeft / dayWidth);
        else if (lastDirectionRef.current < 0) targetDayIndex = Math.floor(currentLeft / dayWidth);
        else targetDayIndex = Math.round(currentLeft / dayWidth);

        const alignLeft = targetDayIndex * dayWidth;

        if (Math.abs(currentLeft - alignLeft) > 0.5) {
            isSystemScrollRef.current = true;
            const startLeft = currentLeft;
            const change = alignLeft - startLeft;
            const duration = 250 + Math.min(Math.abs(change) * 0.5, 250);
            const startTime = performance.now();

            const animate = (currentTime: number) => {
                if (!isSystemScrollRef.current || !scrollRef.current) return;
                const elapsed = currentTime - startTime;
                const progress = Math.min(elapsed / duration, 1);
                const ease = 1 - Math.pow(1 - progress, 4);

                scrollRef.current.scrollLeft = startLeft + change * ease;

                if (progress < 1) {
                    animationFrameRef.current = requestAnimationFrame(animate);
                } else {
                    isSystemScrollRef.current = false;
                    lastDirectionRef.current = 0;
                }
            };
            animationFrameRef.current = requestAnimationFrame(animate);
        }
    }, [interaction.draft, interaction.editingId, scrollRef]);

    const markSystemScrollComplete = useCallback((delay = 120) => {
        if (settleTimeoutRef.current) clearTimeout(settleTimeoutRef.current);
        settleTimeoutRef.current = setTimeout(() => {
            const el = scrollRef.current;
            if (!el || isSystemScrollRef.current) return;

            const currentScrollX = el.scrollLeft;
            if (Math.abs(currentScrollX - lastScrollXRef.current) > 0.5) {
                lastScrollXRef.current = currentScrollX;
                markSystemScrollComplete(80);
                return;
            }
            performSettlement(currentScrollX);
        }, delay);
    }, [scrollRef, performSettlement]);

    // ===== Initialization & Compensation =====
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el || viewportWidth <= 0) return;

        const currentMondayStr = anchorMonday.toDateString();

        // 1. Initial Mount
        if (!lastMondayRef.current) {
            isProgrammaticScrollRef.current = true;
            lastProgrammaticScrollRef.current = Date.now();
            el.scrollLeft = 2 * viewportWidth;
            el.scrollTop = getDefaultScrollTop(now, el.scrollHeight);
            lastMondayRef.current = currentMondayStr;
            viewportWidthRef.current = viewportWidth; // Sync width ref
            setTimeout(() => { isProgrammaticScrollRef.current = false; }, 300);
            return;
        }

        // 2. Handle Resizing
        if (Math.abs(viewportWidth - viewportWidthRef.current) > 1) {
            isProgrammaticScrollRef.current = true;
            lastProgrammaticScrollRef.current = Date.now();

            // Re-center based on current Date (keep user at same date)
            // Ideally we re-calculate from dateToScrollLeft
            // But for simplicity, we know we want to stay 'centered' relative to the anchor
            // oldScrollRatio = el.scrollLeft / oldWidth
            // newScrollLeft = oldScrollRatio * newWidth
            // This maintains relative position roughly

            const ratio = el.scrollLeft / viewportWidthRef.current;
            el.scrollLeft = ratio * viewportWidth;

            viewportWidthRef.current = viewportWidth;

            setTimeout(() => { isProgrammaticScrollRef.current = false; }, 100);
            return;
        }

        // 3. Handle Weekly Compensation (Infinite Scroll)
        if (currentMondayStr !== lastMondayRef.current) {
            const oldMonday = new Date(lastMondayRef.current);
            const diffWeeks = Math.round((anchorMonday.getTime() - oldMonday.getTime()) / (7 * 24 * 60 * 60 * 1000));

            if (diffWeeks !== 0 && !isProgrammaticScrollRef.current) {
                // Simplified compensation:
                // 1. Mark as programmatic to ignore scroll events
                // 2. Adjust scrollLeft immediately
                // 3. Update lastMondayRef immediately to prevent loops

                isProgrammaticScrollRef.current = true;
                lastProgrammaticScrollRef.current = Date.now();

                // Suspend settlement checks briefly
                isSystemScrollRef.current = true;
                if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);

                el.scrollLeft -= (diffWeeks * viewportWidth);
                lastMondayRef.current = currentMondayStr;

                // Reset flags after a short delay to allow browser layout to settle
                setTimeout(() => {
                    isProgrammaticScrollRef.current = false;
                    isSystemScrollRef.current = false;
                }, 50);
            } else {
                lastMondayRef.current = currentMondayStr;
            }
        }
    }, [anchorMonday, viewportWidth, scrollRef]);

    // Sync with viewDate (external jump)
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || viewportWidth <= 0) return;
        if (viewDate.toDateString() !== centerDate.toDateString()) {
            isProgrammaticScrollRef.current = true;
            lastProgrammaticScrollRef.current = Date.now();
            el.scrollLeft = dateToScrollLeft(viewDate, viewportWidth, getMonday(viewDate));
            setTimeout(() => { isProgrammaticScrollRef.current = false; }, 300);
        }
    }, [viewDate, viewportWidth, scrollRef]);

    const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        const target = e.currentTarget;
        const scrollLeft = target.scrollLeft;
        const vWidth = viewportWidthRef.current;

        if (interaction.draft || interaction.editingId) return;
        if (Date.now() - lastProgrammaticScrollRef.current < 500) return;
        if (vWidth <= 0) return;

        const newCenterDate = scrollLeftToDate(scrollLeft, vWidth, anchorMonday);

        if (newCenterDate.toDateString() !== centerDate.toDateString()) {
            setCenterDate(newCenterDate);
            if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
            scrollTimerRef.current = setTimeout(() => {
                if (setViewDate && newCenterDate.toDateString() !== viewDate.toDateString()) {
                    setViewDate(newCenterDate);
                }
            }, 50);
        }

        if (!isSystemScrollRef.current) {
            if (scrollLeft !== lastScrollXRef.current) {
                lastDirectionRef.current = scrollLeft > lastScrollXRef.current ? 1 : -1;
            }
            lastScrollXRef.current = scrollLeft;
            markSystemScrollComplete(150);
        }
    }, [anchorMonday, centerDate, setCenterDate, setViewDate, viewDate, interaction, markSystemScrollComplete]);

    return { handleScroll };
}
