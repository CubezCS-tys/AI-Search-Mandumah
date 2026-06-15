"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Lock } from "lucide-react";
import { login } from "@/lib/admin/api";
import { setSession } from "@/lib/admin/auth";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await login(username.trim(), password);
      setSession(res.token, res.username);
      router.replace("/admin");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-accent/12 text-accent">
            <Lock size={18} />
          </div>
          <h1 className="font-heading text-xl font-semibold text-text-primary">Vector Console</h1>
          <p className="mt-1 text-[12.5px] text-text-muted">المنظومة · admin sign in</p>
        </div>

        <form
          onSubmit={submit}
          className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-border bg-bg-elevated p-6 shadow-[var(--shadow-md)]"
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-text-secondary">Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              className="rounded-[var(--radius)] border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-text-secondary">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="rounded-[var(--radius)] border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
            />
          </label>

          {error && (
            <p className="rounded-[var(--radius)] border border-accent/30 bg-accent-subtle px-3 py-2 text-[12.5px] text-accent">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !username || !password}
            className="mt-1 flex items-center justify-center gap-2 rounded-[var(--radius)] bg-accent px-4 py-2.5 text-sm font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
          >
            {busy && <Loader2 className="animate-spin" size={15} />}
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
