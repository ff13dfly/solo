import { type ButtonHTMLAttributes, forwardRef } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'success' | 'danger' | 'ghost' | 'outline' | 'service' | 'service-danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    isLoading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({
    className = '',
    variant = 'primary',
    size = 'md',
    isLoading = false,
    children,
    ...props
}, ref) => {
    const baseStyles = 'inline-flex items-center justify-center font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bg-primary focus:ring-accent rounded-md cursor-pointer';

    const variants = {
        primary: 'bg-accent text-bg-primary hover:bg-accent/90 shadow-md border border-accent/20 active:scale-95',
        secondary: 'bg-bg-secondary border border-border text-text-primary hover:bg-border/80 hover:text-white active:scale-95 px-4 shadow-inner',
        success: 'bg-[#58a6ff]/10 border border-[#58a6ff]/50 text-[#58a6ff] hover:bg-[#58a6ff] hover:text-white active:scale-95 transition-all shadow-[0_4px_12px_rgba(88,166,255,0.1)]',
        danger: 'bg-[#da3633]/10 border border-[#da3633]/50 text-[#da3633] hover:bg-[#da3633] hover:text-white active:scale-95 transition-all shadow-[0_4px_12px_rgba(218,54,51,0.1)]',
        service: 'bg-[rgba(56,139,253,0.15)] border border-[rgba(56,139,253,0.4)] text-[#58a6ff] hover:bg-[#1f6feb] hover:border-[#388bfd] hover:text-white active:scale-95 transition-all',
        'service-danger': 'bg-[rgba(248,81,73,0.15)] border border-[rgba(248,81,73,0.4)] text-[#f85149] hover:bg-[#da3633] hover:border-[#f85149] hover:text-white active:scale-95 transition-all',
        ghost: 'bg-transparent text-text-secondary hover:text-text-primary hover:bg-white/5',
        outline: 'bg-transparent border border-border text-text-secondary hover:border-accent hover:text-accent',
    };

    const sizes = {
        sm: 'text-xs px-2 py-1 h-6 min-w-[60px]',
        md: 'text-sm px-4 py-2 h-9',
        lg: 'text-base px-6 py-3 h-11',
    };

    return (
        <button
            ref={ref}
            className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${className}`}
            disabled={isLoading || props.disabled}
            {...props}
        >
            {isLoading ? (
                <span className="mr-2 h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : null}
            {children}
        </button>
    );
});

Button.displayName = 'Button';
