import { InputHTMLAttributes, forwardRef, ReactNode } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
    label?: string;
    error?: string;
    leftIcon?: ReactNode;
    rightAction?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(({
    className = '',
    label,
    error,
    leftIcon,
    rightAction,
    ...props
}, ref) => {
    return (
        <div className="w-full">
            {label && (
                <label className="block text-xs uppercase text-text-secondary font-semibold mb-2">
                    {label}
                </label>
            )}
            <div className="relative flex items-center">
                {leftIcon && (
                    <div className="absolute left-3 text-text-secondary pointer-events-none">
                        {leftIcon}
                    </div>
                )}
                <input
                    ref={ref}
                    className={`
            w-full bg-bg-primary border rounded-md px-3 py-2 text-sm text-text-primary
            placeholder:text-text-secondary/50 transition-colors
            focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent
            disabled:opacity-50 disabled:cursor-not-allowed
            ${leftIcon ? 'pl-9' : ''}
            ${error ? 'border-error focus:border-error focus:ring-error' : 'border-border'}
            ${className}
          `}
                    {...props}
                />
                {rightAction && (
                    <div className="absolute right-2">
                        {rightAction}
                    </div>
                )}
            </div>
            {error && <p className="mt-1 text-xs text-error">{error}</p>}
        </div>
    );
});

Input.displayName = 'Input';
