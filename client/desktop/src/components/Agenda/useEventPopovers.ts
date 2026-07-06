import React, { useState } from 'react';
import { PlannerTodo } from '../Todo/useTodoSync';
import { AgendaEvent, PRESET_COLORS } from './AgendaTypes';

export interface PopoverState {
    rect: DOMRect;
    targetId?: string;
}

export function useEventPopovers() {
    const [colorPickerAnchor, setColorPickerAnchor] = useState<PopoverState | null>(null);
    const [todoPickerAnchor, setTodoPickerAnchor] = useState<PopoverState | null>(null);
    const [mentionSearch, setMentionSearch] = useState<string | null>(null);
    const [mentionAnchor, setMentionAnchor] = useState<DOMRect | null>(null);

    const openColorPicker = (rect: DOMRect, targetId?: string) => {
        setColorPickerAnchor({ rect, targetId });
    };

    const openTodoPicker = (rect: DOMRect, targetId?: string) => {
        setTodoPickerAnchor({ rect, targetId });
    };

    const closePickers = () => {
        setColorPickerAnchor(null);
        setTodoPickerAnchor(null);
    };

    const handleTitleChangeForMentions = (
        val: string,
        inputElement: HTMLInputElement,
        onSearch: (search: string | null) => void
    ) => {
        const lastHashIndex = val.lastIndexOf('#');
        if (lastHashIndex !== -1) {
            const searchPart = val.slice(lastHashIndex + 1);
            if (!searchPart.includes(' ')) {
                const rect = inputElement.getBoundingClientRect();
                const caretIndex = inputElement.selectionStart || 0;

                // Estimate caret position: 
                // We'll use the textarea's line height and average char width for a rough guess.
                // This is much better than the whole box rect.
                const lineIndex = val.substring(0, caretIndex).split('\n').length - 1;
                const charIndexInLine = caretIndex - val.lastIndexOf('\n', caretIndex - 1) - 1;

                const lineHeight = 20; // Estimated
                const charWidth = 8; // Estimated

                const adjustedLeft = rect.left + (charIndexInLine * charWidth);
                const adjustedTop = rect.top + (lineIndex * lineHeight) + 24;

                const adjustedRect = {
                    left: adjustedLeft,
                    top: adjustedTop,
                    right: adjustedLeft + 10,
                    bottom: adjustedTop + 24,
                } as any as DOMRect;

                setMentionSearch(searchPart);
                setMentionAnchor(adjustedRect);
                onSearch(searchPart);
                return;
            }
        }
        setMentionSearch(null);
        onSearch(null);
    };

    return {
        colorPickerAnchor,
        setColorPickerAnchor,
        todoPickerAnchor,
        setTodoPickerAnchor,
        mentionSearch,
        setMentionSearch,
        mentionAnchor,
        setMentionAnchor,
        openColorPicker,
        openTodoPicker,
        closePickers,
        handleTitleChangeForMentions
    };
}
