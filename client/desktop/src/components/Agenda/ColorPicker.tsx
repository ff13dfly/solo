import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { PRESET_COLORS } from './AgendaTypes';

interface ColorPickerProps {
    currentColor: string;
    todoColor?: string;
    onSelect: (color: string | null) => void; // null means reset to todo/default
    onClose: () => void;
    anchorRect: DOMRect | null;
}

export const ColorPicker: React.FC<ColorPickerProps> = ({
    currentColor,
    todoColor,
    onSelect,
    onClose,
    anchorRect
}) => {
    if (!anchorRect) return null;

    const top = (anchorRect.bottom + 8) + 'px';
    const left = anchorRect.left + 'px';

    return (
        <>
            <div className="fixed inset-0 z-[90]" onMouseDown={(e) => { e.preventDefault(); onClose(); }} />
            <motion.div
                initial={{ opacity: 0, scale: 0.95, y: -10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: -10 }}
                className="fixed z-[100] p-2 bg-white/95 backdrop-blur-xl rounded-2xl shadow-2xl border border-black/5 flex items-center gap-2"
                style={{ top, left }}
            >
                <div className="flex gap-2">
                    {PRESET_COLORS.map((color: string) => (
                        <div
                            key={color}
                            className={`w-6 h-6 rounded-full cursor-pointer transition-all hover:scale-110 ring-offset-2 ${currentColor === color ? 'ring-2 ring-blue-500 scale-110' : ''
                                }`}
                            style={{ backgroundColor: color }}
                            onClick={() => {
                                onSelect(color);
                                onClose();
                            }}
                        />
                    ))}
                </div>

                {todoColor ? (
                    <>
                        <div className="w-[1px] h-4 bg-black/10 mx-1" />
                        <div
                            className={`w-6 h-6 rounded-full cursor-pointer transition-all hover:scale-110 ring-offset-2 border border-black/5 ${!currentColor ? 'ring-2 ring-blue-500 scale-110' : ''
                                }`}
                            style={{ backgroundColor: todoColor }}
                            title="Follow Todo Color"
                            onClick={() => {
                                onSelect(null); // Signal reset to inherit
                                onClose();
                            }}
                        />
                    </>
                ) : (
                    <>
                        <div className="w-[1px] h-4 bg-black/10 mx-1" />
                        <div
                            className="text-[10px] font-bold text-[#0071e3] px-2 py-1 hover:bg-black/5 rounded-md cursor-pointer whitespace-nowrap"
                            onClick={() => {
                                onSelect(null);
                                onClose();
                            }}
                        >
                            Reset
                        </div>
                    </>
                )}
            </motion.div>
        </>
    );
};
