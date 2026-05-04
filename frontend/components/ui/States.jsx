export function EmptyState({ title, description, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      {description && <p className="max-w-md text-sm text-slate-500">{description}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ title = "Something went wrong", description, onRetry }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-red-200 bg-red-50 px-6 py-10 text-center">
      <h3 className="text-base font-semibold text-red-700">{title}</h3>
      {description && <p className="max-w-md text-sm text-red-700/80">{description}</p>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100"
        >
          Try again
        </button>
      )}
    </div>
  );
}
