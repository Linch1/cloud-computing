"use client";

import { clearSession, emitAuthChange, getToken, setStoredUser, setToken } from "./auth.js";

const BASE_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001").replace(/\/+$/, "");

export class ApiError extends Error {
  constructor({ status, code, message, details, issues }) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.details = details;
    this.issues = issues;
  }
}

async function request(path, { method = "GET", body, auth = false, signal } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    throw new ApiError({
      status: 0,
      code: "NETWORK_ERROR",
      message: "Cannot reach the API. Is the backend running?",
      details: { cause: String(err) },
    });
  }

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    if (res.status === 401 && auth) {
      clearSession();
      emitAuthChange();
    }
    throw new ApiError({
      status: res.status,
      code: payload?.error || "HTTP_ERROR",
      message: payload?.message || res.statusText || "Request failed",
      details: payload?.details,
      issues: payload?.issues,
    });
  }

  return payload;
}

export const api = {
  // --- Auth ---
  async register({ email, password }) {
    return request("/auth/register", { method: "POST", body: { email, password } });
  },
  async login({ email, password }) {
    const data = await request("/auth/login", { method: "POST", body: { email, password } });
    if (data?.token) {
      setToken(data.token);
      setStoredUser(data.user);
      emitAuthChange();
    }
    return data;
  },
  async getMe() {
    return request("/auth/me", { auth: true });
  },
  logout() {
    clearSession();
    emitAuthChange();
  },

  // --- Public elections ---
  async getElections() {
    return request("/elections");
  },
  async getElection(id) {
    return request(`/elections/${encodeURIComponent(id)}`);
  },
  async getElectionStatus(id) {
    return request(`/elections/${encodeURIComponent(id)}/status`);
  },

  // --- Admin ---
  async createElection(payload) {
    return request("/admin/elections", { method: "POST", body: payload, auth: true });
  },
  async openElection(id) {
    return request(`/admin/elections/${encodeURIComponent(id)}/open`, { method: "POST", auth: true });
  },
  async closeElection(id) {
    return request(`/admin/elections/${encodeURIComponent(id)}/close`, { method: "POST", auth: true });
  },
  async getAdminElections() {
    return request("/admin/elections", { auth: true });
  },

  // --- Voting ---
  async vote(id, selectedOption) {
    return request(`/elections/${encodeURIComponent(id)}/vote`, {
      method: "POST",
      body: { selectedOption },
      auth: true,
    });
  },
  async getMyVoteStatus(id) {
    return request(`/elections/${encodeURIComponent(id)}/my-vote-status`, { auth: true });
  },
};

export { BASE_URL };
