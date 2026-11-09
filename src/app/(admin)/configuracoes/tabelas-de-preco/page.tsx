import { requireAdminPage } from "@/lib/auth/page-guard";
import { getCatalogSettings, listBranches, listPriceTables } from "@/lib/catalog/settings";
import { logger } from "@/lib/logger";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../../PageProblem";
import { PriceTableSettings } from "./PriceTableSettings";

export const dynamic = "force-dynamic";

export default async function TabelasDePrecoPage() {
  if ((await requireAdminPage("/configuracoes/tabelas-de-preco")) === "config") return <PageProblem kind="config" />;
  let data;
  try {
    const sql = getSql();
    const [tables, settings, branches] = await Promise.all([listPriceTables(sql), getCatalogSettings(sql), listBranches(sql)]);
    data = { tables, settings, branches };
  } catch (err) {
    logger.error("Falha ao carregar tabelas de preço", { err });
    return <PageProblem kind="database" />;
  }
  return (
    <>
      <p className="breadcrumb">Configurações</p>
      <h1>Tabelas comerciais</h1>
      <p className="muted">
        Escolha a tabela usada como preço de referência no catálogo e nos rascunhos. A tabela marcada como “normal” na ADS não é assumida
        automaticamente. O preço do anúncio continua sendo definido pelo operador.
      </p>
      <PriceTableSettings
        tables={data.tables.map((t) => ({ ...t, adsUpdatedAt: t.adsUpdatedAt ? new Date(t.adsUpdatedAt).toISOString() : null, updatedAt: new Date(t.updatedAt).toISOString() }))}
        settings={data.settings}
        branches={data.branches}
      />
    </>
  );
}
