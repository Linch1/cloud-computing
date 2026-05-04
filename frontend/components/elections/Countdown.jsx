"use client";

import { useEffect, useState } from "react";
import { formatRemaining, unixNow } from "@/lib/format.js";

export function Countdown({ targetUnix, prefix = "" }) {
  const [, tick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!targetUnix) return null;
  const remaining = targetUnix - unixNow();
  if (remaining <= 0) return null;

  return (
    <span className="font-mono text-xs text-slate-600">
      {prefix}
      {formatRemaining(targetUnix)}
    </span>
  );
}
