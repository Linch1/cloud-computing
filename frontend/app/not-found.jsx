import Link from "next/link";
import { Container } from "@/components/layout/Container.jsx";

export default function NotFound() {
  return (
    <Container>
      <div className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
        <p className="text-sm uppercase tracking-wide text-slate-500">404</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Page not found</h1>
        <p className="mt-2 text-sm text-slate-600">The page you are looking for does not exist.</p>
        <Link
          href="/"
          className="mt-4 inline-flex items-center justify-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          Back to home
        </Link>
      </div>
    </Container>
  );
}
