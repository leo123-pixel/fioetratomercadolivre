import { requireAdminPage } from "@/lib/auth/page-guard";
import { logger } from "@/lib/logger";
import { productEditorView } from "@/lib/nuvemshop/products-admin";
import { getLatestStore } from "@/lib/nuvemshop/store";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../../../PageProblem";
import { NuvemshopTabs } from "../../NuvemshopTabs";
import { ProductEditor } from "./ProductEditor";

export const dynamic = "force-dynamic";

export default async function NuvemshopProductEditorPage({ params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;
  if ((await requireAdminPage(`/nuvemshop/catalogo/${productId}`)) === "config") return <PageProblem kind="config" />;
  if (!/^\d{1,20}$/.test(productId)) return <div className="empty-state">Produto inválido.</div>;
  let view;
  try {
    const sql = getSql();
    const store = await getLatestStore(sql);
    view = store ? await productEditorView(sql, store.storeId, productId) : null;
  } catch (err) {
    logger.error("Falha ao carregar o editor de produto Nuvemshop", { err });
    return <PageProblem kind="database" />;
  }
  return (
    <>
      <p className="breadcrumb">
        <a href="/nuvemshop">Nuvemshop</a> › <a href="/nuvemshop/produtos">Produtos</a> › Editar
      </p>
      <div className="page-head">
        <h1>Editar produto Nuvemshop</h1>
        <span className="muted">Produto {productId} · cada alteração é enviada, relida na loja e registrada</span>
      </div>
      <NuvemshopTabs current="products" />
      {view ? <ProductEditor productId={productId} view={JSON.parse(JSON.stringify(view))} /> : <div className="empty-state">Produto não encontrado no catálogo importado. Importe o catálogo na visão geral.</div>}
    </>
  );
}
