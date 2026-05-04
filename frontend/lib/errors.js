import { ApiError } from "./api.js";

export function describeApiError(err, fallback = "Something went wrong") {
  if (err instanceof ApiError) {
    if (err.code === "VALIDATION_ERROR" && Array.isArray(err.issues)) {
      const first = err.issues[0];
      if (first) {
        const path = Array.isArray(first.path) ? first.path.join(".") : first.path;
        return `${path ? path + ": " : ""}${first.message}`;
      }
    }
    return err.message || err.code || fallback;
  }
  return err?.message || fallback;
}
