"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import toast from "react-hot-toast";
import { api } from "@/lib/api.js";
import { describeApiError } from "@/lib/errors.js";
import { formatUnix } from "@/lib/format.js";
import { RequireAuth } from "@/components/auth/RequireAuth.jsx";
import { Container } from "@/components/layout/Container.jsx";
import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";
import { Button } from "@/components/ui/Button.jsx";
import { PageSpinner } from "@/components/ui/Spinner.jsx";
import { EmptyState, ErrorState } from "@/components/ui/States.jsx";
import { ElectionStatusBadge } from "@/components/elections/ElectionStatusBadge.jsx";

export default function AdminElectionsPage() {
  return (
    <RequireAuth role="admin">
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const [state, setState] = useState({ loading: true, elections: [], error: null });
  const [pendingId, setPendingId] = useState(null);

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

  const open = async (id) => {
    setPendingId(id);
    try {
      await api.openElection(id);
      toast.success(`Election #${id} opened`);
      await load();
    } catch (err) {
      toast.error(describeApiError(err, "Could not open"));
    } finally {
      setPendingId(null);
    }
  };

  const close = async (id) => {
    if (!confirm(`Close election #${id}? This is final.`)) return;
    setPendingId(id);
    try {
      await api.closeElection(id);
      toast.success(`Election #${id} closed`);
      await load();
    } catch (err) {
      toast.error(describeApiError(err, "Could not close"));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <Container>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Elections</h1>
          <p className="text-sm text-slate-500">Open or close existing elections.</p>
        </div>
        <Link
          href="/admin/elections/new"
          className="inline-flex items-center justify-center rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          + New election
        </Link>
      </div>

      {state.loading ? (
        <PageSpinner />
      ) : state.error ? (
        <ErrorState description={state.error} onRetry={load} />
      ) : state.elections.length === 0 ? (
        <EmptyState title="No elections" description="Create the first election to get started." />
      ) : (
        <Card>
          <CardHeader>
            <h2 className="text-base font-semibold text-slate-900">All elections</h2>
          </CardHeader>
          <CardBody className="overflow-x-auto p-0">
            <table className="min-w-full divide-y divide-slate-100 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">Title</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Window</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {state.elections.map((e) => (
                  <tr key={e.id}>
                    <td className="px-4 py-3 font-mono text-slate-500">{e.id}</td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/elections/${e.id}`}
                        className="font-medium text-slate-900 hover:text-brand-700"
                      >
                        {e.title}
                      </Link>
                      <p className="text-xs text-slate-500">{e.options.length} options</p>
                    </td>
                    <td className="px-4 py-3">
                      <ElectionStatusBadge status={e.status} />
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      <div>{formatUnix(e.startTime)}</div>
                      <div>↓ {formatUnix(e.endTime)}</div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex gap-2">
                        {e.status === "created" && (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={pendingId === e.id}
                            onClick={() => open(e.id)}
                          >
                            Open now
                          </Button>
                        )}
                        {e.status === "active" && (
                          <Button
                            size="sm"
                            variant="danger"
                            loading={pendingId === e.id}
                            onClick={() => close(e.id)}
                          >
                            Close
                          </Button>
                        )}
                        <Link
                          href={`/admin/elections/${e.id}`}
                          className="inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50"
                        >
                          View
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}
    </Container>
  );
}
