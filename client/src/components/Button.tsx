import { ButtonHTMLAttributes } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  // Soft blue gradient + a slight lift on hover -- the brand's primary action.
  primary:
    "bg-gradient-to-b from-brand-500 to-brand-600 text-on-accent shadow-md shadow-brand-600/25 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-brand-600/30 active:translate-y-0",
  // White (surface) with a border, per the design system.
  secondary:
    "border border-ink-600 bg-ink-800 text-strong shadow-soft hover:-translate-y-0.5 hover:border-brand-400",
  ghost: "text-ink-300 hover:bg-ink-800 hover:text-strong",
  danger:
    "bg-gradient-to-b from-red-500 to-red-600 text-on-accent shadow-md shadow-red-600/25 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-red-600/30 active:translate-y-0",
};

export default function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-semibold transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-none ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    />
  );
}
