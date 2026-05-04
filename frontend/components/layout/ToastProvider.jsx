"use client";

import { Toaster } from "react-hot-toast";

export function ToastProvider() {
  return (
    <Toaster
      position="top-right"
      toastOptions={{
        className: "text-sm",
        success: { duration: 4000 },
        error: { duration: 6000 },
      }}
    />
  );
}
