"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { api } from "@/lib/api.js";
import { describeApiError } from "@/lib/errors.js";
import { Button } from "@/components/ui/Button.jsx";

export function VoteForm({ election, onVoted }) {
  const [selected, setSelected] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (selected == null) return;
    setSubmitting(true);
    try {
      const data = await api.vote(election.id, selected);
      toast.success("Vote recorded on-chain");
      onVoted?.(data.vote);
    } catch (err) {
      toast.error(describeApiError(err, "Could not cast your vote"));
    } finally {
      setSubmitting(false);
      setConfirming(false);
    }
  };

  return (
    <div className="space-y-4">
      <fieldset className="space-y-2" disabled={submitting}>
        <legend className="text-sm font-medium text-slate-700">Choose one option</legend>
        {election.options.map((opt, i) => (
          <label
            key={i}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
              selected === i
                ? "border-brand-500 bg-brand-50"
                : "border-slate-200 bg-white hover:bg-slate-50"
            }`}
          >
            <input
              type="radio"
              name="option"
              className="mt-1 accent-brand-600"
              checked={selected === i}
              onChange={() => setSelected(i)}
            />
            <span className="text-sm text-slate-800">
              <span className="mr-2 text-slate-400">{i + 1}.</span>
              {opt}
            </span>
          </label>
        ))}
      </fieldset>

      {!confirming ? (
        <Button
          onClick={() => setConfirming(true)}
          disabled={selected == null}
          className="w-full"
        >
          Continue
        </Button>
      ) : (
        <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm text-amber-900">
            Confirm your vote for{" "}
            <strong>&ldquo;{election.options[selected]}&rdquo;</strong>. Votes are
            <strong> final</strong> and cannot be changed.
          </p>
          <div className="flex gap-2">
            <Button onClick={submit} loading={submitting} className="flex-1">
              Confirm vote
            </Button>
            <Button
              variant="secondary"
              onClick={() => setConfirming(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
