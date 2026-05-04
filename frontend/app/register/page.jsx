"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import toast from "react-hot-toast";
import { registerSchema } from "@/lib/validators.js";
import { api } from "@/lib/api.js";
import { describeApiError } from "@/lib/errors.js";
import { useAuth } from "@/hooks/useAuth.js";
import { Container } from "@/components/layout/Container.jsx";
import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";
import { Input } from "@/components/ui/Input.jsx";
import { Button } from "@/components/ui/Button.jsx";

export default function RegisterPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(registerSchema),
    defaultValues: { email: "", password: "", confirm: "" },
  });

  useEffect(() => {
    if (loading) return;
    if (user) router.replace(user.role === "admin" ? "/admin" : "/dashboard");
  }, [loading, user, router]);

  const onSubmit = async ({ email, password }) => {
    try {
      await api.register({ email, password });
      await api.login({ email, password });
      toast.success("Account created");
      router.replace("/dashboard");
    } catch (err) {
      toast.error(describeApiError(err, "Registration failed"));
    }
  };

  return (
    <Container>
      <div className="mx-auto max-w-md">
        <Card>
          <CardHeader>
            <h1 className="text-xl font-semibold text-slate-900">Create your account</h1>
            <p className="text-sm text-slate-500">Voter accounts are created here.</p>
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
                autoComplete="new-password"
                placeholder="At least 8 characters"
                error={errors.password?.message}
                {...register("password")}
              />
              <Input
                label="Confirm password"
                type="password"
                autoComplete="new-password"
                error={errors.confirm?.message}
                {...register("confirm")}
              />
              <Button type="submit" loading={isSubmitting} className="w-full">
                Create account
              </Button>
            </form>
            <p className="mt-4 text-center text-sm text-slate-600">
              Already registered?{" "}
              <Link href="/login" className="font-medium text-brand-700 hover:text-brand-800">
                Sign in
              </Link>
            </p>
          </CardBody>
        </Card>
      </div>
    </Container>
  );
}
