"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api.js";
import { describeApiError } from "@/lib/errors.js";
import { formatUnix, shortHash } from "@/lib/format.js";
import { RequireAuth } from "@/components/auth/RequireAuth.jsx";
import { Container } from "@/components/layout/Container.jsx";
import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";
import { Badge } from "@/components/ui/Badge.jsx";
import { PageSpinner } from "@/components/ui/Spinner.jsx";
import { ErrorState } from "@/components/ui/States.jsx";
import { ElectionStatusBadge } from "@/components/elections/ElectionStatusBadge.jsx";
import { Countdown } from "@/components/elections/Countdown.jsx";
import { VoteForm } from "@/components/voting/VoteForm.jsx";
import { VoteReceipt } from "@/components/voting/VoteReceipt.jsx";

export default function ElectionDetailPage() {
  return (
    <RequireAuth>
      <Detail />
    </RequireAuth>
  );
}

function Detail() {
  const { id } = useParams();
  const [election, setElection] = useState(null);
  const [chainStatus, setChainStatus] = useState(null);
  const [myVote, setMyVote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [{ election: e }, { status: cs }, { status: ms }] = await Promise.all([
        api.getElection(id),
        api.getElectionStatus(id),
        api.getMyVoteStatus(id),
      ]);
      setElection(e);
      setChainStatus(cs);
      setMyVote(ms);
    } catch (err) {
      setError(describeApiError(err, "Failed to load election"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  if (loading) return <PageSpinner label="Loading election…" />;
  if (error) return (
    <Container>
      <ErrorState description={error} onRetry={load} />
    </Container>
  );
  if (!election) return null;

  const isActive = (chainStatus?.status || election.status) === "active";
  const hasVoted = myVote?.hasVoted;

  return (
    <Container>
      <Link href="/dashboard" className="text-sm text-brand-700 hover:text-brand-800">
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
            <ElectionStatusBadge status={chainStatus?.status || election.status} />
            {chainStatus?.metadataMatches === false && (
              <Badge tone="danger">metadata mismatch</Badge>
            )}
            {chainStatus?.metadataMatches === true && (
              <Badge tone="success">metadata verified</Badge>
            )}
          </div>
        </CardHeader>
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Info label="Start" value={formatUnix(election.startTime)} />
          <Info label="End" value={formatUnix(election.endTime)} />
          <Info label="Total votes (on-chain)" value={chainStatus?.totalVotes ?? "—"} />
          <Info
            label={isActive ? "Time remaining" : election.status === "created" ? "Starts in" : "Closed"}
            value={
              isActive ? (
                <Countdown targetUnix={election.endTime} />
              ) : election.status === "created" ? (
                <Countdown targetUnix={election.startTime} />
              ) : (
                "—"
              )
            }
          />
          <Info label="Metadata hash" value={shortHash(election.metadataHash, 10, 8)} mono />
          {election.txHash && (
            <Info label="Creation tx" value={shortHash(election.txHash, 10, 8)} mono />
          )}
        </CardBody>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-slate-900">Cast your vote</h2>
          </CardHeader>
          <CardBody>
            {hasVoted ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                <p className="font-medium">You already voted in this election.</p>
                <p className="text-emerald-700/80">Each user can vote only once.</p>
              </div>
            ) : !isActive ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                {election.status === "created"
                  ? "This election has not started yet."
                  : "This election is closed."}
              </div>
            ) : (
              <VoteForm
                election={election}
                onVoted={(vote) => {
                  setMyVote({
                    electionId: election.id,
                    hasVoted: true,
                    source: "off-chain",
                    txHash: vote.txHash,
                    voteHash: vote.voteHash,
                    castAt: vote.castAt,
                  });
                  api.getElectionStatus(id).then(({ status }) => setChainStatus(status)).catch(() => {});
                }}
              />
            )}
          </CardBody>
        </Card>

        {hasVoted && (
          <VoteReceipt
            vote={{
              txHash: myVote.txHash,
              blockNumber: myVote.blockNumber,
              voteHash: myVote.voteHash,
              voterCommitmentHash: myVote.voterCommitmentHash,
              castAt: myVote.castAt || new Date().toISOString(),
            }}
          />
        )}
      </div>
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
