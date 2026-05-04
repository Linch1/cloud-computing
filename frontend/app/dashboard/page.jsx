"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api.js";
import { describeApiError } from "@/lib/errors.js";
import { RequireAuth } from "@/components/auth/RequireAuth.jsx";
import { Container } from "@/components/layout/Container.jsx";
import { ElectionCard } from "@/components/elections/ElectionCard.jsx";
import { PageSpinner } from "@/components/ui/Spinner.jsx";
import { EmptyState, ErrorState } from "@/components/ui/States.jsx";

export default function DashboardPage() {
  return (
    <RequireAuth>
      <DashboardInner />
    </RequireAuth>
  );
}

function DashboardInner() {
  const [state, setState] = useState({ loading: true, elections: [], error: null });

  const load = async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api.getElections();
      setState({ loading: false, elections: data.elections || [], error: null });
    } catch (err) {
      setState({ loading: false, elections: [], error: describeApiError(err, "Failed to load elections") });
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <Container>
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Elections</h1>
          <p className="text-sm text-slate-500">Browse open elections and cast your vote.</p>
        </div>
      </header>

      {state.loading ? (
        <PageSpinner label="Loading elections…" />
      ) : state.error ? (
        <ErrorState description={state.error} onRetry={load} />
      ) : state.elections.length === 0 ? (
        <EmptyState
          title="No elections yet"
          description="When an admin creates an election it will show up here."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {state.elections.map((e) => (
            <ElectionCard key={e.id} election={e} hrefBase="/elections" />
          ))}
        </div>
      )}
    </Container>
  );
}
