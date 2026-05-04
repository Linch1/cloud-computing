"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth.js";
import { PageSpinner } from "@/components/ui/Spinner.jsx";

export function RequireAuth({ role, children }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    if (role && user.role !== role) {
      router.replace(user.role === "admin" ? "/admin" : "/dashboard");
    }
  }, [loading, user, role, router]);

  if (loading || !user || (role && user.role !== role)) {
    return <PageSpinner />;
  }

  return children;
}
