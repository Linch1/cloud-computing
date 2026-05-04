export function Spinner({ size = 20, className = "" }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block animate-spin rounded-full border-2 border-slate-300 border-t-brand-600 ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

export function PageSpinner({ label = "Loading…" }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-slate-500">
      <Spinner size={28} />
      <p className="text-sm">{label}</p>
    </div>
  );
}
