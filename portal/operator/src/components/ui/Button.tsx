import React from 'react';
import './Button.css';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  // tonal = soft accent fill (the canonical "Add"/secondary-action look in this console).
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'icon' | 'tonal';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: React.ReactNode;
  /** Fully rounded (pill) shape — common for the toolbar action buttons. */
  pill?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  pill,
  className = '',
  disabled,
  ...props
}) => {
  const baseClass = `btn btn-${variant} btn-${size}${pill ? ' btn-pill' : ''}`;
  const combinedClass = `${baseClass} ${className}`.trim();

  return (
    <button
      className={combinedClass}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <span className="btn-spinner" />}
      {!loading && icon && <span className="btn-leading-icon">{icon}</span>}
      <span className="btn-text">{children}</span>
    </button>
  );
};
