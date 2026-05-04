"use client";

import { useRouter } from "next/navigation";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import toast from "react-hot-toast";
import { electionFormSchema } from "@/lib/validators.js";
import { api } from "@/lib/api.js";
import { describeApiError } from "@/lib/errors.js";
import { RequireAuth } from "@/components/auth/RequireAuth.jsx";
import { Container } from "@/components/layout/Container.jsx";
import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";
import { Input, TextArea } from "@/components/ui/Input.jsx";
import { Button } from "@/components/ui/Button.jsx";

const defaultStart = () => {
  const d = new Date(Date.now() + 5 * 60_000);
  return toLocal(d);
};

const defaultEnd = () => {
  const d = new Date(Date.now() + 60 * 60_000);
  return toLocal(d);
};

function toLocal(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

export default function NewElectionPage() {
  return (
    <RequireAuth role="admin">
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const router = useRouter();
  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(electionFormSchema),
    defaultValues: {
      title: "",
      description: "",
      options: ["", ""],
      startTime: defaultStart(),
      endTime: defaultEnd(),
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: "options" });

  const onSubmit = async (values) => {
    try {
      const data = await api.createElection(values);
      toast.success(`Election #${data.election.id} created`);
      router.replace(`/admin/elections/${data.election.id}`);
    } catch (err) {
      toast.error(describeApiError(err, "Could not create election"));
    }
  };

  return (
    <Container>
      <div className="mx-auto max-w-2xl">
        <Card>
          <CardHeader>
            <h1 className="text-xl font-semibold text-slate-900">Create election</h1>
            <p className="text-sm text-slate-500">
              The transaction will be sent on-chain by the relayer. Window must be in the future.
            </p>
          </CardHeader>
          <CardBody>
            <form className="space-y-5" onSubmit={handleSubmit(onSubmit)} noValidate>
              <Input
                label="Title"
                placeholder="Best pizza topping"
                error={errors.title?.message}
                {...register("title")}
              />
              <TextArea
                label="Description"
                rows={3}
                placeholder="Optional context for voters"
                error={errors.description?.message}
                {...register("description")}
              />

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="text-sm font-medium text-slate-700">Options</label>
                  <Button type="button" size="sm" variant="secondary" onClick={() => append("")}>
                    + Add option
                  </Button>
                </div>
                <div className="space-y-2">
                  {fields.map((field, index) => (
                    <div key={field.id} className="flex items-start gap-2">
                      <div className="flex-1">
                        <Input
                          placeholder={`Option ${index + 1}`}
                          error={errors.options?.[index]?.message}
                          {...register(`options.${index}`)}
                        />
                      </div>
                      <button
                        type="button"
                        disabled={fields.length <= 2}
                        onClick={() => remove(index)}
                        className="mt-1 rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                {errors.options?.message && (
                  <p className="mt-1 text-xs text-red-600">{errors.options.message}</p>
                )}
                {errors.options?.root?.message && (
                  <p className="mt-1 text-xs text-red-600">{errors.options.root.message}</p>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label="Start time"
                  type="datetime-local"
                  error={errors.startTime?.message}
                  {...register("startTime")}
                />
                <Input
                  label="End time"
                  type="datetime-local"
                  error={errors.endTime?.message}
                  {...register("endTime")}
                />
              </div>

              <div className="flex gap-2 pt-2">
                <Button type="submit" loading={isSubmitting} className="flex-1">
                  Create on-chain
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => router.back()}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      </div>
    </Container>
  );
}
