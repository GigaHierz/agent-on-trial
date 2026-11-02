import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'danger';
type Size = 'md' | 'xl';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-mint text-ink hover:bg-mint-deep',
  secondary: 'border border-line text-fg hover:bg-white/5',
  danger: 'bg-rose-500 text-ink hover:bg-rose-400',
};

const SIZES: Record<Size, string> = {
  md: 'rounded-xl px-5 py-2.5 text-base',
  xl: 'rounded-2xl px-6 py-6 text-3xl',
};

const BASE =
  'inline-flex items-center justify-center gap-2 font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-mint focus-visible:ring-offset-2 focus-visible:ring-offset-ink disabled:opacity-50 active:scale-[0.98]';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  href?: string;
  variant?: Variant;
  size?: Size;
  children: ReactNode;
};

export function Button({ href, variant = 'primary', size = 'md', className = '', children, ...rest }: ButtonProps) {
  const classes = `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${className}`;
  if (href) {
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" className={classes} {...rest}>
      {children}
    </button>
  );
}
