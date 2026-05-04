"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth.js";
import { Container } from "@/components/layout/Container.jsx";
import { Button } from "@/components/ui/Button.jsx";

export default function HomePage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (user) router.replace(user.role === "admin" ? "/admin" : "/dashboard");
  }, [loading, user, router]);

  if (loading || user) return null;

  return (
    <Container>
      <section className="mx-auto max-w-2xl rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
        <h1 className="text-3xl font-bold text-slate-900">Secure on-chain voting</h1>
        <p className="mt-3 text-slate-600">
          Authenticate, browse open elections and cast a vote that is anchored on-chain. The
          backend acts as a relayer — you never need a wallet or a private key.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Button onClick={() => router.push("/login")}>Login</Button>
          <Link
            href="/register"
            className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
          >
            Create account
          </Link>
        </div>
      </section>
    </Container>
  );
}
