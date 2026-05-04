"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api.js";
import { describeApiError } from "@/lib/errors.js";
import { RequireAuth } from "@/components/auth/RequireAuth.jsx";
import { Container } from "@/components/layout/Container.jsx";
import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";
import { Button } from "@/components/ui/Button.jsx";
import { PageSpinner } from "@/components/ui/Spinner.jsx";
import { ErrorState } from "@/components/ui/States.jsx";

export default function AdminDashboardPage() {
  return (
    <RequireAuth role="admin">
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const [state, setState] = useState({ loading: true, elections: [], error: null });

  const load = async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api.getAdminElections();
      setState({ loading: false, elections: data.elections || [], error: null });
    } catch (err) {
      setState({ loading: false, elections: [], error: describeApiError(err) });
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (state.loading) return <PageSpinner label="Loading admin data…" />;
  if (state.error)
    return (
      <Container>
        <ErrorState description={state.error} onRetry={load} />
      </Container>
    );

  const total = state.elections.length;
  const active = state.elections.filter((e) => e.status === "active").length;
  const closed = state.elections.filter((e) => e.status === "closed").length;
  const created = state.elections.filter((e) => e.status === "created").length;

  return (
    <Container>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Admin dashboard</h1>
          <p className="text-sm text-slate-500">Manage elections and monitor on-chain status.</p>
        </div>
        <Link
          href="/admin/elections/new"
          className="inline-flex items-center justify-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          + New election
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total" value={total} />
        <Stat label="Scheduled" value={created} />
        <Stat label="Active" value={active} />
        <Stat label="Closed" value={closed} />
      </div>

      <Card className="mt-6">
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Recent elections</h2>
          <Link href="/admin/elections" className="text-sm font-medium text-brand-700 hover:text-brand-800">
            View all →
          </Link>
        </CardHeader>
        <CardBody>
          {state.elections.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">No elections yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {state.elections.slice(0, 5).map((e) => (
                <li key={e.id} className="flex items-center justify-between py-3">
                  <div className="min-w-0">
                    <Link
                      href={`/admin/elections/${e.id}`}
                      className="block truncate text-sm font-medium text-slate-900 hover:text-brand-700"
                    >
                      #{e.id} — {e.title}
                    </Link>
                    <p className="text-xs text-slate-500">{e.options.length} options</p>
                  </div>
                  <span className="text-xs uppercase text-slate-500">{e.status}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </Container>
  );
}

function Stat({ label, value }) {
  return (
    <Card>
      <CardBody>
        <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
        <p className="mt-1 text-3xl font-semibold text-slate-900">{value}</p>
      </CardBody>
    </Card>
  );
}
