"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { api } from "@/lib/api.js";
import { describeApiError } from "@/lib/errors.js";
import { formatUnix, shortHash } from "@/lib/format.js";
import { RequireAuth } from "@/components/auth/RequireAuth.jsx";
import { Container } from "@/components/layout/Container.jsx";
import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";
import { Button } from "@/components/ui/Button.jsx";
import { Badge } from "@/components/ui/Badge.jsx";
import { PageSpinner } from "@/components/ui/Spinner.jsx";
import { ErrorState } from "@/components/ui/States.jsx";
import { ElectionStatusBadge } from "@/components/elections/ElectionStatusBadge.jsx";
import { Countdown } from "@/components/elections/Countdown.jsx";

export default function AdminElectionDetail() {
  return (
    <RequireAuth role="admin">
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const { id } = useParams();
  const router = useRouter();
  const [election, setElection] = useState(null);
  const [chainStatus, setChainStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionPending, setActionPending] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [{ election: e }, statusResp] = await Promise.all([
        api.getElection(id),
        api.getElectionStatus(id).catch((err) => ({ status: null, _err: err })),
      ]);
      setElection(e);
      setChainStatus(statusResp.status);
    } catch (err) {
      setError(describeApiError(err, "Failed to load election"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  const open = async () => {
    setActionPending("open");
    try {
      await api.openElection(id);
      toast.success("Election opened");
      await load();
    } catch (err) {
      toast.error(describeApiError(err));
    } finally {
      setActionPending(null);
    }
  };

  const close = async () => {
    if (!confirm("Close this election? This is final.")) return;
    setActionPending("close");
    try {
      await api.closeElection(id);
      toast.success("Election closed");
      await load();
    } catch (err) {
      toast.error(describeApiError(err));
    } finally {
      setActionPending(null);
    }
  };

  if (loading) return <PageSpinner />;
  if (error)
    return (
      <Container>
        <ErrorState description={error} onRetry={load} />
      </Container>
    );
  if (!election) return null;

  const status = chainStatus?.status || election.status;

  return (
    <Container>
      <Link href="/admin/elections" className="text-sm text-brand-700 hover:text-brand-800">
        ← Back to elections
      </Link>

      <Card className="mt-3">
        <CardHeader className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-slate-500">Election #{election.id}</p>
            <h1 className="text-2xl font-bold text-slate-900">{election.title}</h1>
            {election.description && (
              <p className="mt-1 text-sm text-slate-600">{election.description}</p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1">
            <ElectionStatusBadge status={status} />
            {chainStatus?.metadataMatches === true && <Badge tone="success">metadata verified</Badge>}
            {chainStatus?.metadataMatches === false && <Badge tone="danger">metadata mismatch</Badge>}
            {chainStatus == null && <Badge tone="warning">chain unreachable</Badge>}
          </div>
        </CardHeader>
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Info label="Start" value={formatUnix(election.startTime)} />
          <Info label="End" value={formatUnix(election.endTime)} />
          <Info label="Total votes (on-chain)" value={chainStatus?.totalVotes ?? "—"} />
          <Info
            label={status === "active" ? "Time remaining" : status === "created" ? "Starts in" : "Closed"}
            value={
              status === "active" ? (
                <Countdown targetUnix={election.endTime} />
              ) : status === "created" ? (
                <Countdown targetUnix={election.startTime} />
              ) : (
                "—"
              )
            }
          />
          <Info label="Metadata hash" value={shortHash(election.metadataHash, 12, 10)} mono />
          {election.txHash && (
            <Info label="Creation tx" value={shortHash(election.txHash, 12, 10)} mono />
          )}
          {election.blockNumber != null && (
            <Info label="Block" value={String(election.blockNumber)} mono />
          )}
        </CardBody>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <h2 className="text-base font-semibold text-slate-900">Lifecycle</h2>
        </CardHeader>
        <CardBody className="flex flex-wrap gap-2">
          {status === "created" && (
            <Button onClick={open} loading={actionPending === "open"}>
              Open now
            </Button>
          )}
          {status === "active" && (
            <Button variant="danger" onClick={close} loading={actionPending === "close"}>
              Close election
            </Button>
          )}
          {status === "closed" && <p className="text-sm text-slate-500">This election is closed.</p>}
          <Button variant="secondary" onClick={() => router.push("/admin/elections")}>
            Back to list
          </Button>
        </CardBody>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <h2 className="text-base font-semibold text-slate-900">Options</h2>
        </CardHeader>
        <CardBody>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-800">
            {election.options.map((opt, i) => (
              <li key={i}>{opt}</li>
            ))}
          </ol>
        </CardBody>
      </Card>
    </Container>
  );
}

function Info({ label, value, mono = false }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`text-sm text-slate-800 ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}
