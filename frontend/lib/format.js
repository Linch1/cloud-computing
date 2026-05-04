export function formatUnix(seconds) {
  if (!seconds) return "—";
  const d = new Date(seconds * 1000);
  return d.toLocaleString();
}

export function shortHash(hash, head = 6, tail = 4) {
  if (!hash || typeof hash !== "string") return "";
  if (hash.length <= head + tail + 2) return hash;
  return `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

export function unixNow() {
  return Math.floor(Date.now() / 1000);
}

export function formatRemaining(targetUnix) {
  const diff = targetUnix - unixNow();
  if (diff <= 0) return "00:00:00";
  const h = String(Math.floor(diff / 3600)).padStart(2, "0");
  const m = String(Math.floor((diff % 3600) / 60)).padStart(2, "0");
  const s = String(diff % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

export function statusLabel(status) {
  switch (status) {
    case "active":
      return "Active";
    case "closed":
      return "Closed";
    case "created":
      return "Created";
    default:
      return status || "—";
  }
}
