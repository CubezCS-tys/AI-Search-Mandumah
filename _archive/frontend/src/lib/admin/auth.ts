"use client";

/* Admin auth — token stored in localStorage, used as a Bearer header. */

const TOKEN_KEY = "manthooma_admin_token";
const USER_KEY = "manthooma_admin_user";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function getUsername(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(USER_KEY);
}

export function setSession(token: string, username: string) {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USER_KEY, username);
}

export function clearSession() {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
}

export function isAuthed(): boolean {
  return !!getToken();
}
