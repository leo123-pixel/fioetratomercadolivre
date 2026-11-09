import { requireAdminPage } from "@/lib/auth/page-guard";
import { PageProblem } from "../../PageProblem";
import { CommercialSettingsForm } from "./CommercialSettingsForm";

export const dynamic = "force-dynamic";

export default async function PedidosAdsConfigPage() {
  if ((await requireAdminPage("/configuracoes/pedidos-ads")) === "config") return <PageProblem kind="config" />;
  return (
    <>
      <p className="breadcrumb">Configurações › Pedidos ADS</p>
      <div className="page-head">
        <h1>Configuração comercial dos pedidos</h1>
        <span className="muted">Códigos consultados ao vivo na API da ADS e validados ao salvar</span>
      </div>
      <CommercialSettingsForm />
    </>
  );
}
