import { ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
    size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
}

export function Modal({ isOpen, onClose, title, children, footer, size = 'md' }: ModalProps) {
    useEffect(() => {
        if (isOpen) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = 'unset';
        }
        return () => {
            document.body.style.overflow = 'unset';
        };
    }, [isOpen]);

    if (!isOpen) return null;

    const sizes = {
        sm: 'max-w-md',
        md: 'max-w-xl',
        lg: 'max-w-3xl',
        xl: 'max-w-5xl',
        full: 'max-w-[95vw] h-[90vh]',
    };

    return createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/70 backdrop-blur-[2px] transition-opacity"
                onClick={onClose}
            />

            {/* Content */}
            <div className={`relative flex flex-col w-full ${sizes[size]} bg-bg-secondary border border-border rounded-lg shadow-2xl max-h-[90vh] animate-in fade-in zoom-in-95 duration-200`}>
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-border">
                    <h3 className="text-sm font-bold text-accent uppercase tracking-wide">{title}</h3>
                    <button
                        onClick={onClose}
                        className="text-text-secondary hover:text-error transition-colors text-xl leading-none opacity-60 hover:opacity-100"
                    >
                        &times;
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-6">
                    {children}
                </div>

                {/* Footer */}
                {footer && (
                    <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border bg-bg-primary/50">
                        {footer}
                    </div>
                )}
            </div>
        </div>,
        document.body
    );
}
