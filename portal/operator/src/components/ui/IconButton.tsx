import React from 'react';
import './IconButton.css';

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** ghost = transparent (hover tint); danger = red on hover; secondary = bordered chip. */
  variant?: 'ghost' | 'danger' | 'secondary' | 'tonal';
  size?: 'sm' | 'md';
  /** Round (circular) instead of rounded-square. */
  round?: boolean;
  /** Accessible label — sets both title and aria-label for icon-only buttons. */
  label?: string;
}

/**
 * Icon-only button: square (or round) hit target with a single icon child.
 * Use for row actions (edit/delete), modal close ×, steppers, etc. — anything that
 * was a bespoke inline-styled `<button>` wrapping just an svg/glyph.
 */
export const IconButton: React.FC<IconButtonProps> = ({
  children,
  variant = 'ghost',
  size = 'md',
  round,
  label,
  className = '',
  ...props
}) => {
  const cls = `icon-btn icon-btn-${variant} icon-btn-${size}${round ? ' icon-btn-round' : ''} ${className}`.trim();
  return (
    <button className={cls} title={label} aria-label={label} {...props}>
      {children}
    </button>
  );
};
