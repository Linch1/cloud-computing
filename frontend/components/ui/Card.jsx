export function Card({ className = "", children, ...props }) {
  return (
    <div
      className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className = "", children }) {
  return <div className={`border-b border-slate-100 px-5 py-4 ${className}`}>{children}</div>;
}

export function CardBody({ className = "", children }) {
  return <div className={`px-5 py-4 ${className}`}>{children}</div>;
}

export function CardFooter({ className = "", children }) {
  return <div className={`border-t border-slate-100 px-5 py-3 ${className}`}>{children}</div>;
}
