import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/page-guard";
import { getDraft } from "@/lib/catalog/drafts";
import { listImages, RECOMMENDED_MIN_SIDE } from "@/lib/catalog/images";
import { getProduct, getProductPrices, getProductStocks } from "@/lib/catalog/products";
import { getCatalogSettings } from "@/lib/catalog/settings";
import { ConfigError } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getCapabilities } from "@/lib/meli/capabilities";
import { getSql } from "@/lib/sql";
import { PageProblem } from "../../../PageProblem";
import { ImageManager } from "../../../produtos/[id]/ImageManager";
import { ListingEditor } from "./ListingEditor";

export const dynamic = "force-dynamic";

export default async function PrepareListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  if ((await requireAdminPage(`/anuncios/preparar/${encodeURIComponent(raw)}`)) === "config") return <PageProblem kind="config" />;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) notFound();

  const sql = getSql();
  let data;
  try {
    const draft = await getDraft(sql, id);
    if (!draft) notFound();
    const [product, prices, stocks, images, settings, capabilities] = await Promise.all([
      getProduct(sql, draft.productId),
      getProductPrices(sql, draft.productId),
      getProductStocks(sql, draft.productId),
      listImages(sql, draft.productId),
      getCatalogSettings(sql),
      getCapabilities(sql),
    ]);
    data = { draft, product: product!, prices, stocks, images, settings, capabilities };
  } catch (err) {
    if ((err as { digest?: string })?.digest?.startsWith("NEXT_")) throw err;
    logger.error("Falha ao carregar o editor de anúncio", { id, err });
    return <PageProblem kind={err instanceof ConfigError ? "config" : "database"} />;
  }
  const { draft, product, prices, stocks, images, settings, capabilities } = data;
  const json = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

  return (
    <>
      <p className="breadcrumb">
        <a href="/anuncios">Anúncios</a> › <a href={`/produtos/${product.id}`}>ID ADS {product.adsProductId}</a> › Preparar
      </p>
      <h1 style={{ marginBottom: 12 }}>{product.nameCustom ?? (product.nameOriginal || "(sem descrição na ADS)")}</h1>

      <ListingEditor
        initialDraft={json(draft) as unknown as React.ComponentProps<typeof ListingEditor>["initialDraft"]}
        product={json({
          id: product.id,
          adsProductId: product.adsProductId,
          nameOriginal: product.nameOriginal,
          ean: product.ean,
          manufacturerCode: product.manufacturerCode,
          presentation: product.presentation,
          supplierName: product.supplierName,
          brand: typeof (product.rawPayload as { marca?: unknown })?.marca === "string" ? ((product.rawPayload as { marca: string }).marca.trim() || null) : null,
          inactive: product.inactive,
        })}
        prices={json(prices.map((p) => ({ code: p.priceTableCode, description: p.priceTableDescription, branch: p.branchId, price: p.price, discount: p.discount, inactive: p.inactive })))}
        stocks={json(stocks.map((s) => ({ branch: s.branchId, quantity: s.quantity })))}
        defaultTable={settings.defaultPriceTable}
        capabilities={json(capabilities)}
        imageCount={images.length}
      >
        <ImageManager
          productId={product.id}
          initial={images.map((i) => ({ id: i.id, publicUrl: i.publicUrl, width: i.width, height: i.height, isPrimary: i.isPrimary, originalFilename: i.originalFilename, sizeBytes: i.sizeBytes, mlPictureId: i.mlPictureId }))}
          recommendedMinSide={RECOMMENDED_MIN_SIDE}
          locked={["VALIDATING", "PUBLISHING", "PUBLISHED", "UNKNOWN"].includes(draft.status)}
        />
      </ListingEditor>
    </>
  );
}
