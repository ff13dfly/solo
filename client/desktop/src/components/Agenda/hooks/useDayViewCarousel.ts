import { useState, useEffect, useRef, useCallback } from "react";

interface UseDayViewCarouselProps {
    viewDate: Date;
    handleNavigate: (direction: 'prev' | 'next') => void;
    interaction: any;
}

export function useDayViewCarousel({ viewDate, handleNavigate, interaction }: UseDayViewCarouselProps) {
    const [direction, setDirection] = useState(0);
    const lastViewDateRef = useRef(viewDate.toDateString());

    // Detect direction for animation whenever viewDate changes externally
    useEffect(() => {
        const dateStr = viewDate.toDateString();
        if (dateStr !== lastViewDateRef.current) {
            const lastDate = new Date(lastViewDateRef.current);
            const diff = viewDate.getTime() - lastDate.getTime();
            setDirection(diff > 0 ? 1 : -1);
            lastViewDateRef.current = dateStr;
        }
    }, [viewDate]);

    const paginate = useCallback((newDirection: number) => {
        handleNavigate(newDirection > 0 ? 'next' : 'prev');
    }, [handleNavigate]);

    const variants = {
        enter: (direction: number) => ({
            x: direction > 0 ? "100%" : direction < 0 ? "-100%" : 0,
            opacity: 1
        }),
        center: { x: 0, opacity: 1 },
        exit: (direction: number) => ({
            x: direction < 0 ? "100%" : direction > 0 ? "-100%" : 0,
            opacity: 1
        })
    };

    const dragProps = {
        drag: (interaction.draft || interaction.editingId) ? false : ("x" as const),
        dragDirectionLock: true,
        onDragEnd: (e: any, { offset, velocity }: any) => {
            const swipe = Math.abs(offset.x) > 50 || Math.abs(velocity.x) > 300;
            if (swipe) paginate(offset.x > 0 ? -1 : 1);
        },
        style: { touchAction: 'pan-x pan-y' }
    };

    return {
        direction,
        variants,
        dragProps,
        paginate
    };
}
