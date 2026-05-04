import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";
import { Badge } from "@/components/ui/Badge.jsx";
import { formatUnix, shortHash } from "@/lib/format.js";

export function VoteReceipt({ vote }) {
  return (
    <Card className="border-emerald-200 bg-emerald-50/40">
      <CardHeader className="flex items-center gap-2">
        <Badge tone="success">Vote recorded</Badge>
        <span className="text-sm text-slate-700">
          Cast at {formatUnix(Math.floor(new Date(vote.castAt).getTime() / 1000))}
        </span>
      </CardHeader>
      <CardBody className="space-y-2 font-mono text-xs text-slate-700">
        <Row label="Tx hash" value={vote.txHash} />
        <Row label="Block" value={vote.blockNumber} />
        <Row label="Vote hash" value={vote.voteHash} />
        <Row label="Voter commitment" value={vote.voterCommitmentHash} />
      </CardBody>
    </Card>
  );
}

function Row({ label, value }) {
  if (value == null) return null;
  const display = typeof value === "string" && value.startsWith("0x") ? shortHash(value, 10, 8) : String(value);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span title={String(value)} className="break-all text-slate-800">
        {display}
      </span>
    </div>
  );
}
