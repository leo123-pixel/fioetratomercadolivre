"use client";

import { useState } from "react";

/** Encerra a sessão do administrador (remove o cookie no servidor) e volta para o site institucional. */
export function LogoutButton() {
  const [pending, setPending] = useState(false);

  async function logout() {
    setPending(true);
    try {
      await fetch("/api/admin/logout", { method: "POST", headers: { "content-type": "application/json" } });
    } finally {
      window.location.assign("/");
    }
  }

  return (
    <button className="btn btn-secondary topbar-logout" type="button" onClick={logout} disabled={pending}>
      {pending ? "Saindo…" : "Sair"}
    </button>
  );
}
