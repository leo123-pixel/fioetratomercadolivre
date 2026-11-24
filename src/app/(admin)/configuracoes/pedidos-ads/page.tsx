import { requireAdminPage } from "@/lib/auth/page-guard";
import { PageProblem } from "../../PageProblem";
import { CommercialSettingsForm } from "./CommercialSettingsForm";

export const dynamic = "force-dynamic";

export default async function PedidosAdsConfigPage({ searchParams }: { searchParams: Promise<{ canal?: string }> }) {
  if ((await requireAdminPage("/configuracoes/pedidos-ads")) === "config") return <PageProblem kind="config" />;
  const channel = (await searchParams).canal === "nuvemshop" ? "nuvemshop" : "mercadolivre";
  return (
    <>
      <p className="breadcrumb">Configurações › Pedidos ADS</p>
      <div className="page-head">
        <h1>Configuração comercial dos pedidos</h1>
        <span className="muted">Códigos consultados ao vivo na API da ADS e validados ao salvar</span>
      </div>
      <nav className="tabs" aria-label="Canal">
        <a href="/configuracoes/pedidos-ads" aria-current={channel === "mercadolivre" ? "page" : undefined}>
          Mercado Livre
        </a>
        <a href="/configuracoes/pedidos-ads?canal=nuvemshop" aria-current={channel === "nuvemshop" ? "page" : undefined}>
          Nuvemshop
        </a>
      </nav>
      <CommercialSettingsForm key={channel} channel={channel} />
    </>
  );
}
