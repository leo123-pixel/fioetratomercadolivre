import { requireAdminPage } from "@/lib/auth/page-guard";
import { logger } from "@/lib/logger";
import { listMappings, listUnmappedGroups } from "@/lib/marketplace/mappings";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../../PageProblem";
import { MappingsPanel } from "./MappingsPanel";

export const dynamic = "force-dynamic";

export default async function MapeamentosPage({ searchParams }: { searchParams: Promise<{ item?: string; sku?: string }> }) {
  const sp = await searchParams;
  if ((await requireAdminPage("/pedidos/mapeamentos")) === "config") return <PageProblem kind="config" />;
  let mappings, unmapped;
  try {
    const sql = getSql();
    [mappings, unmapped] = await Promise.all([listMappings(sql), listUnmappedGroups(sql)]);
  } catch (err) {
    logger.error("Falha ao carregar mapeamentos", { err });
    return <PageProblem kind="database" />;
  }
  return (
    <>
      <p className="breadcrumb">
        <a href="/pedidos">Pedidos</a> › Mapeamento de produtos
      </p>
      <div className="page-head">
        <h1>Mapeamento de produtos</h1>
        <span className="muted">Vincule o que foi vendido no Mercado Livre ao produto da ADS. Nunca por semelhança de título.</span>
      </div>
      <MappingsPanel
        mappings={JSON.parse(JSON.stringify(mappings))}
        unmapped={JSON.parse(JSON.stringify(unmapped))}
        focus={{ item: sp.item && /^MLB\d+$/.test(sp.item) ? sp.item : null, sku: sp.sku?.slice(0, 120) ?? null }}
      />
    </>
  );
}
