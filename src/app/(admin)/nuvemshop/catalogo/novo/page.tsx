import { requireAdminPage } from "@/lib/auth/page-guard";
import { PageProblem } from "../../../PageProblem";
import { NuvemshopTabs } from "../../NuvemshopTabs";
import { NewProductForm } from "./NewProductForm";

export const dynamic = "force-dynamic";

export default async function NuvemshopNewProductPage() {
  if ((await requireAdminPage("/nuvemshop/catalogo/novo")) === "config") return <PageProblem kind="config" />;
  return (
    <>
      <p className="breadcrumb">
        <a href="/nuvemshop">Nuvemshop</a> › <a href="/nuvemshop/produtos">Produtos</a> › Criar a partir da ADS
      </p>
      <div className="page-head">
        <h1>Criar produto na Nuvemshop</h1>
        <span className="muted">O produto nasce oculto e com estoque 0; publicar e sincronizar estoque são etapas separadas</span>
      </div>
      <NuvemshopTabs current="products" />
      <NewProductForm />
    </>
  );
}
