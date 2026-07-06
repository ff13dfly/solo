import { ReactNode } from 'react';

interface CardProps {
    children: ReactNode;
    className?: string;
    title?: ReactNode;
    headerAction?: ReactNode;
}

export function Card({ children, className = '', title, headerAction }: CardProps) {
    return (
        <div className={`flex flex-col bg-bg-primary border border-border rounded-lg overflow-hidden ${className}`}>
            {title && (
                <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-secondary/30">
                    <h3 className="text-sm font-bold text-accent uppercase tracking-wide">{title}</h3>
                    {headerAction && <div>{headerAction}</div>}
                </div>
            )}
            <div className="flex-1 p-0 flex flex-col min-h-0">
                {children}
            </div>
        </div>
    );
}

export function CardContent({ children, className = '' }: { children: ReactNode; className?: string }) {
    return (
        <div className={`p-6 ${className}`}>
            {children}
        </div>
    );
}
