import { Badge } from "@/components/ui/Badge.jsx";

const TONES = {
  active: "success",
  closed: "neutral",
  created: "info",
};

const LABELS = {
  active: "Active",
  closed: "Closed",
  created: "Scheduled",
};

export function ElectionStatusBadge({ status }) {
  return <Badge tone={TONES[status] || "neutral"}>{LABELS[status] || status || "—"}</Badge>;
}
