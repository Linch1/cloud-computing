"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import toast from "react-hot-toast";
import { loginSchema } from "@/lib/validators.js";
import { api } from "@/lib/api.js";
import { describeApiError } from "@/lib/errors.js";
import { useAuth } from "@/hooks/useAuth.js";
import { Container } from "@/components/layout/Container.jsx";
import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";
import { Input } from "@/components/ui/Input.jsx";
import { Button } from "@/components/ui/Button.jsx";

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const { user, loading } = useAuth();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({ resolver: zodResolver(loginSchema), defaultValues: { email: "", password: "" } });

  useEffect(() => {
    if (loading) return;
    if (user) router.replace(target(user, search.get("next")));
  }, [loading, user, router, search]);

  const onSubmit = async (values) => {
    try {
      const data = await api.login(values);
      toast.success("Welcome back");
      router.replace(target(data.user, search.get("next")));
    } catch (err) {
      toast.error(describeApiError(err, "Login failed"));
    }
  };

  return (
    <Card>
      <CardHeader>
        <h1 className="text-xl font-semibold text-slate-900">Sign in</h1>
        <p className="text-sm text-slate-500">Use your email and password.</p>
      </CardHeader>
      <CardBody>
        <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
          <Input
            label="Email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            error={errors.email?.message}
            {...register("email")}
          />
          <Input
            label="Password"
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            error={errors.password?.message}
            {...register("password")}
          />
          <Button type="submit" loading={isSubmitting} className="w-full">
            Sign in
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-slate-600">
          No account?{" "}
          <Link href="/register" className="font-medium text-brand-700 hover:text-brand-800">
            Register
          </Link>
        </p>
      </CardBody>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <Container>
      <div className="mx-auto max-w-md">
        <Suspense fallback={<div className="h-32" />}>
          <LoginForm />
        </Suspense>
      </div>
    </Container>
  );
}

function target(user, next) {
  if (next && next.startsWith("/")) return next;
  return user.role === "admin" ? "/admin" : "/dashboard";
}
