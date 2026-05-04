const TONES = {
  neutral: "bg-slate-100 text-slate-700 border-slate-200",
  brand: "bg-brand-50 text-brand-700 border-brand-200",
  success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  warning: "bg-amber-50 text-amber-700 border-amber-200",
  danger: "bg-red-50 text-red-700 border-red-200",
  info: "bg-sky-50 text-sky-700 border-sky-200",
};

export function Badge({ tone = "neutral", className = "", children }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONES[tone] || TONES.neutral} ${className}`}
    >
      {children}
    </span>
  );
}
