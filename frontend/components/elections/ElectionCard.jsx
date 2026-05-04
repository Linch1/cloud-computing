import Link from "next/link";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card.jsx";
import { ElectionStatusBadge } from "./ElectionStatusBadge.jsx";
import { Countdown } from "./Countdown.jsx";
import { formatUnix } from "@/lib/format.js";

export function ElectionCard({ election, hrefBase = "/elections" }) {
  const { id, title, description, options, startTime, endTime, status } = election;

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-slate-900">{title}</h3>
          <p className="text-xs text-slate-500">#{id}</p>
        </div>
        <ElectionStatusBadge status={status} />
      </CardHeader>
      <CardBody className="flex-1">
        {description ? (
          <p className="mb-3 line-clamp-3 text-sm text-slate-600">{description}</p>
        ) : (
          <p className="mb-3 text-sm italic text-slate-400">No description</p>
        )}
        <ul className="space-y-1 text-sm text-slate-700">
          {options?.slice(0, 4).map((opt, i) => (
            <li key={i} className="truncate">
              <span className="text-slate-400">{i + 1}.</span> {opt}
            </li>
          ))}
          {options?.length > 4 && (
            <li className="text-xs text-slate-400">+{options.length - 4} more</li>
          )}
        </ul>
      </CardBody>
      <CardFooter className="flex flex-col gap-1 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-0.5">
          <span>Start: {formatUnix(startTime)}</span>
          <span>End: {formatUnix(endTime)}</span>
        </div>
        <div className="flex flex-col items-start sm:items-end gap-1">
          {status === "created" && <Countdown targetUnix={startTime} prefix="Starts in " />}
          {status === "active" && <Countdown targetUnix={endTime} prefix="Ends in " />}
          <Link
            href={`${hrefBase}/${id}`}
            className="text-sm font-medium text-brand-700 hover:text-brand-800"
          >
            View →
          </Link>
        </div>
      </CardFooter>
    </Card>
  );
}
