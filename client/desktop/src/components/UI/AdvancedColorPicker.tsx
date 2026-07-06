import React, { useRef } from 'react';
import { motion } from 'framer-motion';
import { Pipette } from 'lucide-react';

interface AdvancedColorPickerProps {
    currentColor?: string;
    onSelect: (color: string) => void;
    onClose: () => void;
    anchorRect: DOMRect | null;
}

const PRESET_12_COLORS = [
    "#0071e3", // Blue
    "#34c759", // Green
    "#ff3b30", // Red
    "#ff9500", // Orange
    "#af52de", // Purple
    "#ffcc00", // Yellow
    "#ff2d55", // Pink
    "#5856d6", // Indigo
    "#5ac8fa", // Cyan
    "#00c7be", // Teal
    "#ac8e68", // Brown
    "#8e8e93", // Gray
];

export const AdvancedColorPicker: React.FC<AdvancedColorPickerProps> = ({
    currentColor,
    onSelect,
    onClose,
    anchorRect
}) => {
    const fileInputRef = useRef<HTMLInputElement>(null);

    if (!anchorRect) return null;

    // Position calculation to avoid overflow
    const PADDING = 12;
    const PICKER_WIDTH = 180;
    let left = anchorRect.right - PICKER_WIDTH;
    let top = anchorRect.bottom + 8;

    // Basic viewport check
    if (left < PADDING) left = PADDING;
    if (left + PICKER_WIDTH > window.innerWidth - PADDING) left = window.innerWidth - PICKER_WIDTH - PADDING;

    const handleCustomColorClick = () => {
        fileInputRef.current?.click();
    };

    return (
        <>
            <div
                className="fixed inset-0 z-[90]"
                onMouseDown={(e) => { e.preventDefault(); onClose(); }}
            />
            <motion.div
                initial={{ opacity: 0, scale: 0.95, y: -10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: -10 }}
                className="fixed z-[100] p-3 bg-white/90 backdrop-blur-xl rounded-2xl shadow-2xl border border-black/5 w-[180px]"
                style={{ top, left }}
            >
                <div className="grid grid-cols-4 gap-2 mb-3">
                    {PRESET_12_COLORS.map((color) => (
                        <motion.div
                            key={color}
                            whileHover={{ scale: 1.1 }}
                            whileTap={{ scale: 0.9 }}
                            className={`w-8 h-8 rounded-full cursor-pointer transition-shadow ring-offset-2 ${currentColor?.toLowerCase() === color.toLowerCase() ? 'ring-2 ring-blue-500 shadow-lg' : 'hover:shadow-md'
                                }`}
                            style={{ backgroundColor: color }}
                            onClick={() => {
                                onSelect(color);
                                onClose();
                            }}
                        />
                    ))}
                </div>

                <div className="h-[1px] bg-black/5 mb-2 mx-1" />

                <button
                    onClick={handleCustomColorClick}
                    className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-black/5 transition-colors group"
                >
                    <div className="flex items-center gap-2">
                        <div
                            className="w-4 h-4 rounded-md border border-black/10 shadow-sm"
                            style={{ backgroundColor: currentColor || '#ffffff' }}
                        />
                        <span className="text-[11px] font-bold text-[#1d1d1f] uppercase tracking-wider">Custom</span>
                    </div>
                    <Pipette size={12} className="text-[#86868b] group-hover:text-[#1d1d1f] transition-colors" />
                </button>

                <input
                    ref={fileInputRef}
                    type="color"
                    className="sr-only"
                    value={currentColor || '#0071e3'}
                    onChange={(e) => {
                        onSelect(e.target.value);
                    }}
                />
            </motion.div>
        </>
    );
};
