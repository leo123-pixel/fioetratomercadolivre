"use client";

import { useState, type FormEvent } from "react";

export function LoginForm({ next }: { next: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const password = new FormData(event.currentTarget).get("password");
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        window.location.assign(next);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      setError(data.message ?? "Não foi possível entrar.");
    } catch {
      setError("Falha de rede. Tente novamente.");
    }
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit}>
      {error && <div className="alert error" role="alert">{error}</div>}
      <label htmlFor="password">Senha</label>
      <input id="password" name="password" type="password" autoComplete="current-password" required />
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? "Entrando…" : "Entrar"}
        </button>
      </div>
    </form>
  );
}
