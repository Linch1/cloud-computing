"use client";

const TOKEN_KEY = "voting.jwt";
const USER_KEY = "voting.user";

const isBrowser = () => typeof window !== "undefined";

export function getToken() {
  if (!isBrowser()) return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (!isBrowser()) return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export function getStoredUser() {
  if (!isBrowser()) return null;
  const raw = window.localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setStoredUser(user) {
  if (!isBrowser()) return;
  if (user) window.localStorage.setItem(USER_KEY, JSON.stringify(user));
  else window.localStorage.removeItem(USER_KEY);
}

export function clearSession() {
  setToken(null);
  setStoredUser(null);
}

const AUTH_EVENT = "voting:auth-change";

export function emitAuthChange() {
  if (!isBrowser()) return;
  window.dispatchEvent(new Event(AUTH_EVENT));
}

export function onAuthChange(handler) {
  if (!isBrowser()) return () => {};
  window.addEventListener(AUTH_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(AUTH_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}
