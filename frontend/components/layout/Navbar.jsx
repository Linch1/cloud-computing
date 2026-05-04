"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/hooks/useAuth.js";
import { api } from "@/lib/api.js";
import { Container } from "./Container.jsx";

export function Navbar() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const isAdmin = user?.role === "admin";

  const handleLogout = () => {
    api.logout();
    router.replace("/login");
  };

  const NavLink = ({ href, children }) => (
    <Link
      href={href}
      className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
        pathname === href || pathname?.startsWith(href + "/")
          ? "bg-brand-50 text-brand-700"
          : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
      }`}
    >
      {children}
    </Link>
  );

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/90 backdrop-blur">
      <Container className="flex h-14 items-center justify-between gap-4">
        <Link href={user ? (isAdmin ? "/admin" : "/dashboard") : "/"} className="flex items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white font-bold">
            V
          </span>
          <span className="font-semibold text-slate-900">Voting Platform</span>
        </Link>

        <nav className="flex items-center gap-1">
          {!loading && user ? (
            <>
              {isAdmin ? (
                <>
                  <NavLink href="/admin">Dashboard</NavLink>
                  <NavLink href="/admin/elections">Elections</NavLink>
                  <NavLink href="/admin/elections/new">New</NavLink>
                </>
              ) : (
                <NavLink href="/dashboard">Dashboard</NavLink>
              )}
            </>
          ) : null}
        </nav>

        <div className="flex items-center gap-2">
          {!loading && user ? (
            <>
              <span className="hidden sm:inline text-sm text-slate-600">
                {user.email} <span className="text-slate-400">·</span>{" "}
                <span className="font-medium text-slate-700">{user.role}</span>
              </span>
              <button
                type="button"
                onClick={handleLogout}
                className="px-3 py-1.5 rounded-md text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Logout
              </button>
            </>
          ) : !loading ? (
            <>
              <Link
                href="/login"
                className="px-3 py-1.5 rounded-md text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Login
              </Link>
              <Link
                href="/register"
                className="px-3 py-1.5 rounded-md text-sm font-medium bg-brand-600 text-white hover:bg-brand-700"
              >
                Register
              </Link>
            </>
          ) : null}
        </div>
      </Container>
    </header>
  );
}
