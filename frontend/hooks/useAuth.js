"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api.js";
import { getStoredUser, getToken, onAuthChange } from "@/lib/auth.js";

export function useAuth() {
  const [state, setState] = useState({
    user: null,
    token: null,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;

    const sync = async () => {
      const token = getToken();
      const cached = getStoredUser();
      if (!token) {
        if (!cancelled) setState({ user: null, token: null, loading: false });
        return;
      }
      if (cached) {
        if (!cancelled) setState({ user: cached, token, loading: true });
      }
      try {
        const data = await api.getMe();
        if (!cancelled) setState({ user: data.user, token, loading: false });
      } catch {
        if (!cancelled) setState({ user: null, token: null, loading: false });
      }
    };

    sync();
    const off = onAuthChange(sync);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return state;
}
