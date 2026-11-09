import { redirect } from "next/navigation";
import { getServerAdminSession, safeNextPath } from "@/lib/auth/server-session";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const target = safeNextPath(next, "/configuracoes/integracoes/mercadolivre");
  if (await getServerAdminSession()) redirect(target);

  return (
    <section className="card login-card">
      <h2>Acesso do administrador</h2>
      <p className="muted">Área restrita à configuração do integrador.</p>
      <LoginForm next={target} />
    </section>
  );
}
