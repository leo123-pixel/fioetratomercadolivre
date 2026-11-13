import { redirect } from "next/navigation";
import { getServerAdminSession, safeNextPath } from "@/lib/auth/server-session";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const target = safeNextPath(next, "/painel");
  if (await getServerAdminSession()) redirect(target);

  return (
    <section className="card login-card">
      <h2>Área Administrativa</h2>
      <p className="muted">Lopes Cosméticos · acesso somente para pessoas autorizadas.</p>
      <LoginForm next={target} />
    </section>
  );
}
