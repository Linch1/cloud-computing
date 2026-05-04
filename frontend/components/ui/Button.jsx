"use client";

const VARIANTS = {
  primary:
    "bg-brand-600 hover:bg-brand-700 text-white border border-transparent disabled:bg-brand-300 disabled:cursor-not-allowed",
  secondary:
    "bg-white hover:bg-slate-50 text-slate-900 border border-slate-300 disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed",
  danger:
    "bg-red-600 hover:bg-red-700 text-white border border-transparent disabled:bg-red-300 disabled:cursor-not-allowed",
  ghost:
    "bg-transparent hover:bg-slate-100 text-slate-700 border border-transparent disabled:text-slate-400 disabled:cursor-not-allowed",
};

const SIZES = {
  sm: "px-3 py-1.5 text-sm rounded-md",
  md: "px-4 py-2 text-sm rounded-lg",
  lg: "px-5 py-2.5 text-base rounded-lg",
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  loading = false,
  disabled = false,
  children,
  type = "button",
  ...props
}) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...props}
    >
      {loading && (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}
