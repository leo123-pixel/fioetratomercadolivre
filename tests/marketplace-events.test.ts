import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { POST as webhookRoute } from "@/app/api/webhooks/mercadolivre/route";
import { POST as legacyWebhookRoute } from "@/app/api/mercadolivre/notifications/route";
import { GET as eventsGet, POST as eventsPost } from "@/app/api/marketplace/events/route";
import { POST as reprocessRoute } from "@/app/api/marketplace/events/[id]/reprocess/route";
import { GET as monitoringRoute } from "@/app/api/marketplace/monitoring/route";
import { POST as tickRoute } from "@/app/api/marketplace/scheduler/tick/route";
import { POST as syncJobsRoute } from "@/app/api/marketplace/sync-jobs/route";
import { claimNextEvent, ingestNotification, processEvents, reprocessEvent, setEventHandlersForTesting } from "@/lib/marketplace/events";
import { recoverMissedFeeds } from "@/lib/marketplace/missed-feeds";
import { runSyncJob, runTick, schedulerToken, setTickRunnerForTesting } from "@/lib/marketplace/scheduler";
import { setWebhookProcessorForTesting } from "@/lib/marketplace/webhook";
import { syncAllListings, syncItemDetailed } from "@/lib/publish/listings";
import type { Sql } from "@/lib/sql";
import { BASE, makeRequest } from "./helpers/fixtures";
import { adminCookies } from "./helpers/meli-mock";
import { item, mockMeliEvents, notification, SELLER } from "./helpers/meli-events-mock";
import { useTestDatabase } from "./helpers/pg";
import { seedConnection } from "./helpers/seed";

const t = useTestDatabase();
const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });

async function connected() {
  await seedConnection({ expiresInMs: 3_600_000 });
}

/** Produto + rascunho publicado + anúncio local, como o publicador da fase 3 deixaria. */
async function seedListing(itemId: string, opts: { ads?: number; price?: string; quantity?: number; status?: string; userProductId?: string; familyId?: string } = {}) {
  const sql = t.sql();
  const ads = opts.ads ?? 1804;
  const [{ id: productId }] = await sql.query<{ id: number }>(
    `INSERT INTO products (ads_product_id, name_original, raw_payload) VALUES ($1, $2, '{}') ON CONFLICT (ads_product_id) DO UPDATE SET name_original = EXCLUDED.name_original RETURNING id`,
    [ads, `PRODUTO ${ads}`],
  );
  const [{ id: draftId }] = await sql.query<{ id: number }>(
    `INSERT INTO listing_drafts (product_id, status, listing_price, listing_quantity) VALUES ($1, 'PUBLISHED', $2::numeric, $3)
     ON CONFLICT (product_id) DO UPDATE SET status = 'PUBLISHED' RETURNING id`,
    [productId, opts.price ?? "99.90", opts.quantity ?? 3],
  );
  const [{ id }] = await sql.query<{ id: number }>(
    `INSERT INTO marketplace_listings (product_id, ads_product_id, listing_draft_id, marketplace_account_id, marketplace_item_id, category_id,
       price, quantity, status, user_product_id, family_id)
     VALUES ($1, $2, $3, $4, $5, 'MLB264861', $6::numeric, $7, $8, $9, $10) RETURNING id`,
    [productId, ads, draftId, SELLER, itemId, opts.price ?? "99.90", opts.quantity ?? 3, opts.status ?? "active", opts.userProductId ?? null, opts.familyId ?? null],
  );
  return { productId, draftId, listingId: id };
}

const listing = async (itemId: string) =>
  (
    await t.sql().query<Record<string, unknown>>(
      `SELECT status, remote_status AS "remoteStatus", remote_sub_status AS "remoteSubStatus", remote_price::text AS "remotePrice",
              remote_quantity AS "remoteQuantity", price::text AS price, quantity, remote_last_updated AS "remoteLastUpdated",
              sync_error_code AS "syncErrorCode", last_synced_at AS "lastSyncedAt"
       FROM marketplace_listings WHERE marketplace_item_id = $1`,
      [itemId],
    )
  )[0];
const openIssues = async (itemId?: string) =>
  (
    await t.sql().query<{ type: string }>(
      `SELECT issue_type AS type FROM marketplace_reconciliation_issues WHERE resolved_at IS NULL ${itemId ? "AND marketplace_item_id = $1" : ""} ORDER BY issue_type`,
      itemId ? [itemId] : [],
    )
  ).map((r) => r.type);
const events = async () =>
  t.sql().query<{ id: string; status: string; topic: string; attempts: number; ignoredReason: string | null; lastErrorCode: string | null; source: string; coalescedInto: string | null }>(
    `SELECT id::text AS id, status, topic, attempts, ignored_reason AS "ignoredReason", last_error_code AS "lastErrorCode", source,
            coalesced_into::text AS "coalescedInto" FROM marketplace_webhook_events ORDER BY id`,
  );

function webhook(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(new URL("/api/webhooks/mercadolivre", BASE), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
describe("webhook POST /api/webhooks/mercadolivre", () => {
  it("evento válido: grava PENDING antes de responder 200 e dispara o processamento assíncrono da raia", async () => {
    await connected();
    mockMeliEvents();
    const lanes: string[] = [];
    setWebhookProcessorForTesting((lane) => lanes.push(lane));
    const res = await webhookRoute(webhook(notification("items", "/items/MLB1000")));
    expect(res.status).toBe(200);
    expect(await events()).toMatchObject([{ status: "PENDING", topic: "items", source: "webhook" }]);
    expect(lanes).toEqual(["listings"]);
  });

  it("não faz chamadas externas antes de responder", async () => {
    await connected();
    const { handler } = mockMeliEvents();
    await webhookRoute(webhook(notification("orders_v2", "/orders/2000001")));
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejeita payloads inválidos, grandes demais e de outra aplicação (nada é gravado)", async () => {
    await connected();
    mockMeliEvents();
    expect((await webhookRoute(webhook("{nao-e-json"))).status).toBe(400);
    expect((await webhookRoute(webhook({ topic: "items" }))).status).toBe(400);
    expect((await webhookRoute(webhook(notification("items", "/items/../users/me")))).status).toBe(400);
    expect((await webhookRoute(webhook(notification("items", "/items/MLB1?x=1")))).status).toBe(400);
    expect((await webhookRoute(webhook(notification("items", "/items/MLB1000", { application_id: 999 })))).status).toBe(403);
    expect((await webhookRoute(webhook({ ...notification("items", "/items/MLB1000"), lixo: "x".repeat(20_000) }))).status).toBe(413);
    expect(await events()).toHaveLength(0);
  });

  it("eventos duplicados (mesmo _id, reentrega do ML) são gravados uma única vez", async () => {
    await connected();
    mockMeliEvents();
    const n = notification("items", "/items/MLB1000");
    expect((await webhookRoute(webhook(n))).status).toBe(200);
    expect((await webhookRoute(webhook({ ...n, attempts: 2 }))).status).toBe(200);
    expect(await events()).toHaveLength(1);
  });

  it("tópico desconhecido e conta diferente são guardados como IGNORED (sem processamento)", async () => {
    await connected();
    mockMeliEvents();
    const lanes: string[] = [];
    setWebhookProcessorForTesting((lane) => lanes.push(lane));
    await webhookRoute(webhook(notification("questions", "/questions/123")));
    await webhookRoute(webhook(notification("items", "/items/MLB1000", { user_id: 999 })));
    expect((await events()).map((e) => [e.status, e.ignoredReason])).toEqual([
      ["IGNORED", "unsupported_topic"],
      ["IGNORED", "unknown_seller"],
    ]);
    expect(lanes).toEqual([]);
  });

  it("sem gravação durável não há 200: falha do banco responde 500 (o ML reenviará)", async () => {
    await connected();
    mockMeliEvents();
    const { setSqlForTesting } = await import("@/lib/sql");
    const broken: Sql = {
      query: async () => {
        throw new Error("connection refused");
      },
      execute: async () => {
        throw new Error("connection refused");
      },
      transaction: async () => {
        throw new Error("connection refused");
      },
    };
    setSqlForTesting(broken);
    const res = await webhookRoute(webhook(notification("items", "/items/MLB1000")));
    setSqlForTesting(t.sql());
    expect(res.status).toBe(500);
  });

  it("a URL antiga (/api/mercadolivre/notifications) usa o mesmo fluxo persistente", async () => {
    await connected();
    mockMeliEvents();
    const res = await legacyWebhookRoute(webhook(notification("items", "/items/MLB1000")) as never);
    expect(res.status).toBe(200);
    expect(await events()).toHaveLength(1);
  });

  it("respeita a lista opcional de IPs de origem", async () => {
    await connected();
    mockMeliEvents();
    process.env.MELI_WEBHOOK_ALLOWED_IPS = "54.88.218.97";
    try {
      expect((await webhookRoute(webhook(notification("items", "/items/MLB1000"), { "x-real-ip": "1.2.3.4" }))).status).toBe(403);
      expect((await webhookRoute(webhook(notification("items", "/items/MLB1000"), { "x-real-ip": "54.88.218.97" }))).status).toBe(200);
    } finally {
      delete process.env.MELI_WEBHOOK_ALLOWED_IPS;
    }
  });
});

// ---------------------------------------------------------------------------
describe("fila de eventos: processamento, idempotência, retentativas e recuperação", () => {
  it("evento de item: relê na API e atualiza o banco local (status, preço, quantidade)", async () => {
    await connected();
    const { state } = mockMeliEvents();
    await seedListing("MLB1000");
    state.items.set("MLB1000", item("MLB1000", { status: "paused", price: 89.9, available_quantity: 1 }));
    await ingestNotification(t.sql(), notification("items", "/items/MLB1000"));
    const r = await processEvents({ sql: t.sql() });
    expect(r.byStatus).toEqual({ COMPLETED: 1 });
    expect(await listing("MLB1000")).toMatchObject({ status: "paused", remoteStatus: "paused", remotePrice: "89.90", remoteQuantity: 1, price: "99.90", quantity: 3 });
    expect(await openIssues("MLB1000")).toEqual(["PRICE_DIVERGENCE", "QUANTITY_DIVERGENCE", "STATUS_DIVERGENCE"]);
    expect(state.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("eventos repetidos do mesmo recurso: uma leitura atende a todos (coalescência), sem leituras extras", async () => {
    await connected();
    const { state } = mockMeliEvents();
    await seedListing("MLB1000");
    state.items.set("MLB1000", item("MLB1000"));
    for (let i = 0; i < 3; i++) await ingestNotification(t.sql(), notification("items", "/items/MLB1000"));
    await processEvents({ sql: t.sql() });
    const evs = await events();
    expect(evs.map((e) => e.status)).toEqual(["COMPLETED", "COMPLETED", "COMPLETED"]);
    expect(evs.filter((e) => e.coalescedInto === evs[0].id)).toHaveLength(2);
    expect(state.calls.filter((c) => c.path === "/items/MLB1000")).toHaveLength(1);
  });

  it("eventos fora de ordem: leitura com last_updated mais antigo não sobrescreve dados mais novos", async () => {
    await connected();
    const { state } = mockMeliEvents();
    await seedListing("MLB1000");
    state.items.set("MLB1000", item("MLB1000", { status: "paused", last_updated: "2026-11-05T12:00:00.000Z" }));
    await syncItemDetailed(t.sql(), "MLB1000");
    state.items.set("MLB1000", item("MLB1000", { status: "active", last_updated: "2026-11-05T11:00:00.000Z" }));
    const r = await syncItemDetailed(t.sql(), "MLB1000");
    expect(r.stale).toBe(true);
    expect(await listing("MLB1000")).toMatchObject({ status: "paused", remoteStatus: "paused" });
  });

  it("item da conta sem correspondência local: registrado como NOT_LINKED, sem vínculo automático", async () => {
    await connected();
    const { state } = mockMeliEvents();
    state.items.set("MLB5555", item("MLB5555", { attributes: [{ id: "SELLER_SKU", value_name: "XYZ" }] }));
    await ingestNotification(t.sql(), notification("items", "/items/MLB5555"));
    await processEvents({ sql: t.sql() });
    expect(await openIssues("MLB5555")).toEqual(["NOT_LINKED"]);
    expect((await t.sql().query(`SELECT 1 FROM marketplace_listings`)).length).toBe(0);
  });

  it("falha temporária (5xx/timeout): RETRYING com backoff e histórico de erro; depois conclui", async () => {
    await connected();
    const { state } = mockMeliEvents();
    await seedListing("MLB1000");
    state.items.set("MLB1000", item("MLB1000", { status: "paused" }));
    // withReadRetry tenta 3x dentro da mesma execução: 3 falhas esgotam essa tentativa.
    state.failures.push({ prefix: "/items/MLB1000", kind: "500" }, { prefix: "/items/MLB1000", kind: "timeout" }, { prefix: "/items/MLB1000", kind: "500" });
    await ingestNotification(t.sql(), notification("items", "/items/MLB1000"));
    await processEvents({ sql: t.sql() });
    const [ev] = await events();
    expect(ev).toMatchObject({ status: "RETRYING", attempts: 1 });
    const [next] = await t.sql().query<{ future: boolean }>(`SELECT next_attempt_at > now() + interval '20 seconds' AS future FROM marketplace_webhook_events`);
    expect(next.future).toBe(true);
    expect(await t.sql().query(`SELECT retryable FROM marketplace_event_processing_errors`)).toEqual([{ retryable: true }]);
    expect((await listing("MLB1000")).syncErrorCode).toMatch(/^server/);
    // vence o backoff
    await t.sql().execute(`UPDATE marketplace_webhook_events SET next_attempt_at = now()`);
    await processEvents({ sql: t.sql() });
    expect((await events())[0]).toMatchObject({ status: "COMPLETED", attempts: 2 });
    expect(await listing("MLB1000")).toMatchObject({ status: "paused", syncErrorCode: null });
  });

  it("limite de tentativas leva a FAILED (dead-letter); reprocessamento administrativo recoloca na fila", async () => {
    await connected();
    mockMeliEvents();
    setEventHandlersForTesting({
      items: async () => {
        throw new Error("falha persistente");
      },
    });
    try {
      await ingestNotification(t.sql(), notification("items", "/items/MLB1000"));
      await t.sql().execute(`UPDATE marketplace_webhook_events SET max_attempts = 2`);
      await processEvents({ sql: t.sql() });
      await t.sql().execute(`UPDATE marketplace_webhook_events SET next_attempt_at = now()`);
      await processEvents({ sql: t.sql() });
      const [ev] = await events();
      expect(ev).toMatchObject({ status: "FAILED", attempts: 2, lastErrorCode: "internal_error" });
      expect(await reprocessEvent(t.sql(), ev.id)).toBe(true);
      expect((await events())[0]).toMatchObject({ status: "PENDING", attempts: 0 });
    } finally {
      setEventHandlersForTesting(null);
    }
  });

  it("erro de autenticação na consulta (401 do ML / conta sem conexão) é registrado como falha de auth e repetido depois", async () => {
    await connected();
    const { state } = mockMeliEvents();
    await seedListing("MLB1000");
    state.failures.push({ prefix: "/items/MLB1000", kind: "401" });
    await ingestNotification(t.sql(), notification("items", "/items/MLB1000"));
    await processEvents({ sql: t.sql() });
    expect((await events())[0]).toMatchObject({ status: "RETRYING", lastErrorCode: expect.stringMatching(/^auth/) });
    const [{ n }] = await t.sql().query<{ n: number }>(`SELECT count(*)::int AS n FROM marketplace_event_processing_errors WHERE error_code LIKE 'auth%'`);
    expect(n).toBe(1);
  });

  it("recuperação após falha do worker: evento PROCESSING com lease vencido é retomado", async () => {
    await connected();
    const { state } = mockMeliEvents();
    await seedListing("MLB1000");
    state.items.set("MLB1000", item("MLB1000", { status: "closed" }));
    await ingestNotification(t.sql(), notification("items", "/items/MLB1000"));
    const claimed = await claimNextEvent(t.sql(), "listings"); // worker "morre" aqui
    expect(claimed).not.toBeNull();
    expect(await claimNextEvent(t.sql(), "listings")).toBeNull(); // lease ainda válido
    await t.sql().execute(`UPDATE marketplace_webhook_events SET locked_until = now() - interval '1 second'`);
    await processEvents({ sql: t.sql() });
    expect((await events())[0]).toMatchObject({ status: "COMPLETED", attempts: 2 });
    expect((await listing("MLB1000")).status).toBe("closed");
  });

  it("user_products e families relêem os anúncios vinculados; sem vínculo local → IGNORED", async () => {
    await connected();
    const { state } = mockMeliEvents();
    await seedListing("MLB1000", { userProductId: "MLBU123", familyId: "777" });
    state.items.set("MLB1000", item("MLB1000", { status: "paused" }));
    state.userProducts.set("MLBU123", { id: "MLBU123", family_id: 777 });
    await ingestNotification(t.sql(), notification("user_products", "/user-products/MLBU123", { actions: ["updated"] }));
    await ingestNotification(t.sql(), notification("user_products_families", "/sites/MLB/user-products-families/777", { actions: ["families_members"] }));
    await ingestNotification(t.sql(), notification("user_products", "/user-products/MLBU999", { actions: ["purged"] }));
    await processEvents({ sql: t.sql() });
    expect((await events()).map((e) => [e.topic, e.status, e.ignoredReason])).toEqual([
      ["user_products", "COMPLETED", null],
      ["user_products_families", "COMPLETED", null],
      ["user_products", "IGNORED", "no_local_listing"],
    ]);
    expect((await listing("MLB1000")).status).toBe("paused");
  });
});

// ---------------------------------------------------------------------------
describe("gestão de anúncios: reconciliação periódica (somente leitura)", () => {
  it("identifica ativo, pausado, encerrado, em revisão e excluído (404), preservando o status original da API", async () => {
    await connected();
    const { state } = mockMeliEvents();
    const ids = ["MLB1", "MLB2", "MLB3", "MLB4", "MLB5", "MLB6"];
    for (const [i, id] of ids.entries()) await seedListing(id, { ads: 100 + i });
    state.items.set("MLB1", item("MLB1", { attributes: [{ id: "SELLER_SKU", value_name: "ADS-100" }] }));
    state.items.set("MLB2", item("MLB2", { status: "paused", sub_status: ["out_of_stock"], attributes: [{ id: "SELLER_SKU", value_name: "ADS-101" }] }));
    state.items.set("MLB3", item("MLB3", { status: "closed", attributes: [{ id: "SELLER_SKU", value_name: "ADS-102" }] }));
    state.items.set("MLB4", item("MLB4", { status: "under_review", sub_status: ["forbidden"], attributes: [{ id: "SELLER_SKU", value_name: "ADS-103" }] }));
    state.items.set("MLB5", item("MLB5", { status: "closed", sub_status: ["deleted"], attributes: [{ id: "SELLER_SKU", value_name: "ADS-104" }] }));
    // MLB6 não existe mais (404)
    const r = await syncAllListings(t.sql());
    expect(r).toMatchObject({ checked: 6, failed: 0 });
    const got = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await listing(id)])));
    expect(got.MLB1).toMatchObject({ status: "active", remoteStatus: "active" });
    expect(got.MLB2).toMatchObject({ status: "paused", remoteStatus: "paused", remoteSubStatus: ["out_of_stock"] });
    expect(got.MLB3).toMatchObject({ status: "closed", remoteStatus: "closed" });
    expect(got.MLB4).toMatchObject({ status: "under_review", remoteStatus: "under_review" });
    expect(got.MLB5).toMatchObject({ status: "deleted", remoteStatus: "closed", remoteSubStatus: ["deleted"] });
    expect(got.MLB6).toMatchObject({ status: "deleted", remoteStatus: "not_found" });
    expect(await openIssues("MLB1")).toEqual([]);
    expect(await openIssues("MLB2")).toEqual(["STATUS_DIVERGENCE"]);
    expect(await openIssues("MLB3")).toEqual(["CLOSED_REMOTE"]);
    expect(await openIssues("MLB5")).toEqual(["REMOVED_REMOTE"]);
    expect(state.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("paginação: multiget em lotes de 20 e busca de itens do vendedor paginada; detecta anúncios sem vínculo", async () => {
    await connected();
    const { state } = mockMeliEvents();
    for (let i = 0; i < 45; i++) {
      const id = `MLB${2000 + i}`;
      await seedListing(id, { ads: 3000 + i });
      state.items.set(id, item(id, { attributes: [{ id: "SELLER_SKU", value_name: `ADS-${3000 + i}` }] }));
    }
    for (let i = 0; i < 160; i++) state.items.set(`MLB${9000 + i}`, item(`MLB${9000 + i}`, { attributes: [] }));
    const r = await syncAllListings(t.sql());
    expect(r).toMatchObject({ checked: 45, changed: 0, failed: 0, unlinked: 160 });
    const multigets = state.calls.filter((c) => c.path === "/items");
    expect(multigets.length).toBe(3 + 8); // 45 conhecidos em 3 lotes + 160 desconhecidos em 8 lotes
    expect(state.calls.filter((c) => c.path === `/users/${SELLER}/items/search`).map((c) => new URLSearchParams(c.query).get("offset"))).toEqual(["0", "100", "200"]); // 205 itens na conta
    expect((await openIssues()).filter((x) => x === "NOT_LINKED")).toHaveLength(160);
  });

  it("detecta alterações feitas direto no ML e resolve a divergência quando os valores voltam", async () => {
    await connected();
    const { state } = mockMeliEvents();
    await seedListing("MLB1000", { price: "99.90", quantity: 3 });
    state.items.set("MLB1000", item("MLB1000", { price: 79.9, available_quantity: 3, last_updated: "2026-11-05T10:00:00Z" }));
    await syncAllListings(t.sql());
    expect(await openIssues("MLB1000")).toEqual(["PRICE_DIVERGENCE"]);
    const [snap] = await t.sql().query<{ n: number }>(`SELECT count(*)::int AS n FROM marketplace_listing_snapshots`);
    expect(snap.n).toBe(1);
    state.items.set("MLB1000", item("MLB1000", { price: 99.9, available_quantity: 3, last_updated: "2026-11-05T11:00:00Z" }));
    await syncAllListings(t.sql());
    expect(await openIssues("MLB1000")).toEqual([]);
    // Nada além de leituras; preço publicado e rascunho intactos.
    expect(state.calls.every((c) => c.method === "GET")).toBe(true);
    expect(await listing("MLB1000")).toMatchObject({ price: "99.90", quantity: 3 });
    const [d] = await t.sql().query<{ p: string }>(`SELECT listing_price::text AS p FROM listing_drafts`);
    expect(d.p).toBe("99.90");
  });

  it("vínculo incompleto: SELLER_SKU ausente ou diferente do produto ADS é sinalizado", async () => {
    await connected();
    const { state } = mockMeliEvents();
    await seedListing("MLB1000", { ads: 1804 });
    state.items.set("MLB1000", item("MLB1000", { attributes: [{ id: "BRAND", value_name: "X" }] }));
    await syncAllListings(t.sql());
    expect(await openIssues("MLB1000")).toEqual(["INCOMPLETE_LINK"]);
  });

  it("rotina registrada em marketplace_sync_jobs; execução concorrente é recusada (lease)", async () => {
    await connected();
    const { state } = mockMeliEvents();
    await seedListing("MLB1000");
    state.items.set("MLB1000", item("MLB1000", { status: "paused" }));
    const job = await runSyncJob(t.sql(), "LISTINGS_RECONCILE", "manual");
    expect(job).toMatchObject({ status: "COMPLETED", processed: 1, changed: 1 });
    await t.sql().execute(`INSERT INTO worker_leases (name, owner, lease_until) VALUES ('ml-sync:LISTINGS_RECONCILE', 'outro', now() + interval '1 minute')`);
    expect((await runSyncJob(t.sql(), "LISTINGS_RECONCILE", "manual")).status).toBe("BUSY");
    const jobs = await t.sql().query<{ status: string; processed: number }>(`SELECT status, total_processed AS processed FROM marketplace_sync_jobs`);
    expect(jobs).toEqual([{ status: "COMPLETED", processed: 1 }]);
  });

  it("rate limit (429) na leitura: repete respeitando Retry-After e conclui", async () => {
    await connected();
    const { state } = mockMeliEvents();
    await seedListing("MLB1000");
    state.items.set("MLB1000", item("MLB1000"));
    state.failures.push({ prefix: "/items", kind: "429" });
    const r = await syncAllListings(t.sql());
    expect(r).toMatchObject({ checked: 1, failed: 0 });
  });
});

// ---------------------------------------------------------------------------
describe("recuperação de notificações perdidas (missed_feeds)", () => {
  it("consulta por tópico (site_id=MLB para items), deduplica com o webhook e processa idempotentemente", async () => {
    await connected();
    const { state } = mockMeliEvents();
    const already = notification("items", "/items/MLB1000");
    await ingestNotification(t.sql(), already);
    state.missedFeeds.items = [
      { ...already, request: { data: JSON.stringify(already) }, response: { http_code: 500 } },
      { ...notification("items", "/items/MLB1001"), request: { data: "{}" } },
    ];
    state.missedFeeds.orders_v2 = [notification("orders_v2", "/orders/2000009")];
    const r = await recoverMissedFeeds(t.sql());
    expect(r).toMatchObject({ fetched: 3, stored: 2, duplicates: 1, rejected: 0 });
    expect(state.calls.find((c) => c.path === "/missed_feeds" && c.query.includes("topic=items"))!.query).toContain("site_id=MLB");
    expect((await events()).map((e) => e.source)).toEqual(["webhook", "missed_feeds", "missed_feeds"]);
    const again = await recoverMissedFeeds(t.sql());
    expect(again).toMatchObject({ stored: 0, duplicates: 3 });
  });
});

// ---------------------------------------------------------------------------
describe("agendador server-side", () => {
  it("tick roda as rotinas vencidas uma vez; o tick seguinte não repete antes do intervalo", async () => {
    await connected();
    const { state } = mockMeliEvents();
    await seedListing("MLB1000");
    state.items.set("MLB1000", item("MLB1000"));
    const first = await runTick(t.sql(), "scheduler");
    expect(first.jobs.map((j) => j.type).sort()).toEqual(["LISTINGS_RECONCILE", "MISSED_FEEDS", "ORDERS_RECOVERY"]);
    const second = await runTick(t.sql(), "scheduler");
    expect(second.jobs).toEqual([]);
    const [reg] = await t.sql().query<{ value: { url: string; token: string } }>(`SELECT value FROM app_settings WHERE key = 'meli_scheduler'`);
    expect(reg.value.url).toBe("https://integrador.test/api/marketplace/scheduler/tick");
  });

  it("sem conta conectada o tick não consulta o ML", async () => {
    const { handler } = mockMeliEvents();
    const r = await runTick(t.sql(), "scheduler");
    expect(r.jobs).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("endpoint de tick exige token interno ou CRON_SECRET", async () => {
    const triggers: string[] = [];
    setTickRunnerForTesting((tr) => triggers.push(tr));
    expect((await tickRoute(makeRequest("/api/marketplace/scheduler/tick", { method: "POST" }))).status).toBe(401);
    expect((await tickRoute(makeRequest("/api/marketplace/scheduler/tick", { method: "POST", headers: { "x-scheduler-token": "errado" } }))).status).toBe(401);
    expect((await tickRoute(makeRequest("/api/marketplace/scheduler/tick", { method: "POST", headers: { "x-scheduler-token": schedulerToken() } }))).status).toBe(202);
    process.env.CRON_SECRET = "segredo-de-teste-cron";
    try {
      expect((await tickRoute(makeRequest("/api/marketplace/scheduler/tick", { method: "POST", headers: { authorization: "Bearer segredo-de-teste-cron" } }))).status).toBe(202);
    } finally {
      delete process.env.CRON_SECRET;
    }
    expect(triggers).toEqual(["scheduler", "cron"]);
  });
});

// ---------------------------------------------------------------------------
describe("segurança dos endpoints administrativos", () => {
  it("sem sessão de administrador: 401; sem mesma origem em POST: 403", async () => {
    expect((await eventsGet(makeRequest("/api/marketplace/events"))).status).toBe(401);
    expect((await monitoringRoute(makeRequest("/api/marketplace/monitoring"))).status).toBe(401);
    expect((await reprocessRoute(makeRequest("/api/marketplace/events/1/reprocess", { method: "POST" }), ctx({ id: "1" }))).status).toBe(401);
    expect((await syncJobsRoute(makeRequest("/api/marketplace/sync-jobs", { method: "POST", cookies: adminCookies(), body: { type: "LISTINGS_RECONCILE" } }))).status).toBe(403);
    expect(
      (await eventsPost(makeRequest("/api/marketplace/events", { method: "POST", cookies: adminCookies(), headers: { origin: "https://evil.test" }, body: { action: "reprocess-failed", confirm: true } }))).status,
    ).toBe(403);
  });

  it("validação de entrada nos filtros e IDs", async () => {
    expect((await eventsGet(makeRequest("/api/marketplace/events?status=DROP", { cookies: adminCookies() }))).status).toBe(400);
    expect((await reprocessRoute(makeRequest("/api/marketplace/events/1;x/reprocess", { method: "POST", cookies: adminCookies(), headers: { origin: BASE } }), ctx({ id: "1;x" }))).status).toBe(400);
  });

  it("monitoramento não expõe tokens nem o token do agendador", async () => {
    await connected();
    mockMeliEvents();
    await runTick(t.sql(), "manual");
    const res = await monitoringRoute(makeRequest("/api/marketplace/monitoring", { cookies: adminCookies() }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(schedulerToken());
    expect(text).not.toMatch(/APP_USR|TG-|accessTokenEnc|refreshTokenEnc/);
    const body = JSON.parse(text);
    expect(body.connection.status).toBe("connected");
  });

  it("reprocessamento autorizado de evento com falha (somente leitura no ML)", async () => {
    await connected();
    const { state } = mockMeliEvents();
    await seedListing("MLB1000");
    state.items.set("MLB1000", item("MLB1000", { status: "paused" }));
    await ingestNotification(t.sql(), notification("items", "/items/MLB1000"));
    await t.sql().execute(`UPDATE marketplace_webhook_events SET status = 'FAILED'`);
    const [ev] = await events();
    const res = await reprocessRoute(makeRequest(`/api/marketplace/events/${ev.id}/reprocess`, { method: "POST", cookies: adminCookies(), headers: { origin: BASE } }), ctx({ id: ev.id }));
    expect(res.status).toBe(200);
    expect((await res.json()).event.status).toBe("COMPLETED");
    expect(state.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("payload do evento guardado contém só os campos documentados (sem cabeçalhos ou campos extras)", async () => {
    await connected();
    mockMeliEvents();
    await ingestNotification(t.sql(), { ...notification("items", "/items/MLB1000"), authorization: "Bearer APP_USR-x", extra: { a: 1 } });
    const [row] = await t.sql().query<{ payload: Record<string, unknown> }>(`SELECT payload FROM marketplace_webhook_events`);
    expect(Object.keys(row.payload).sort()).toEqual(["_id", "actions", "application_id", "attempts", "received", "resource", "sent", "topic", "user_id"]);
  });
});

vi.setConfig({ testTimeout: 30_000 });
