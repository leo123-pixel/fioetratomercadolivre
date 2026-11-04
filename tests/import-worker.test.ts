import { describe, expect, it } from "vitest";
import { acquireLease, cancelJob, createJob, getJob, JobConflictError, listJobErrors, retryJob } from "@/lib/imports/jobs";
import { MAX_ATTEMPTS, processJobs } from "@/lib/imports/worker";
import { defaultData, mockAds, price, product, stock, table } from "./helpers/ads-mock";
import { useTestDatabase } from "./helpers/pg";

const t = useTestDatabase();
const noSleep = async () => {};

async function runAll(maxSlices = 20) {
  for (let i = 0; i < maxSlices; i++) {
    const r = await processJobs({ sql: t.sql(), budgetMs: 5_000, sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 20))) });
    if (!r.more) return r;
  }
  throw new Error("worker não terminou");
}

async function count(table: string): Promise<number> {
  const [{ n }] = await t.sql().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return n;
}

function catalog(n: number) {
  const data = defaultData();
  data.products = Array.from({ length: n }, (_, i) => product(1000 + i));
  return data;
}

describe("importação de produtos (paginação + UPSERT)", () => {
  it("percorre todas as páginas, registra progresso e importa fornecedores/divisões", async () => {
    const { calls } = mockAds(catalog(7));
    const job = await createJob(t.sql(), "PRODUCTS");
    await runAll();
    const done = (await getJob(t.sql(), job.id))!;
    expect(done).toMatchObject({ status: "COMPLETED", total: 7, processed: 7, created: 7, updated: 0, failed: 0 });
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect(calls.filter((c) => c.resource === "produtos").map((c) => c.page)).toEqual([1, 2, 3]);
    expect(await count("products")).toBe(7);
    expect(await count("ads_suppliers")).toBe(1);
    expect(await count("ads_divisions")).toBe(1);
  });

  it("reexecutar não duplica; mudanças na ADS contam como atualização", async () => {
    const data = catalog(5);
    mockAds(data);
    await createJob(t.sql(), "PRODUCTS");
    await runAll();
    data.products[2] = { ...data.products[2], descricao: "NOME ALTERADO NA ADS" };
    const second = await createJob(t.sql(), "PRODUCTS");
    await runAll();
    expect(await getJob(t.sql(), second.id)).toMatchObject({ status: "COMPLETED", created: 0, updated: 1, unchanged: 4 });
    expect(await count("products")).toBe(5);
    const [row] = await t.sql().query<{ name: string }>(`SELECT name_original AS name FROM products WHERE ads_product_id = 1002`);
    expect(row.name).toBe("NOME ALTERADO NA ADS");
  });

  it("preserva edições manuais (nome personalizado, imagens e rascunho) após nova importação", async () => {
    const data = catalog(2);
    mockAds(data);
    await createJob(t.sql(), "PRODUCTS");
    await runAll();
    await t.sql().execute(`UPDATE products SET name_custom = 'Oxidante 20 Volumes 950ml' WHERE ads_product_id = 1000`);
    await t.sql().execute(
      `INSERT INTO product_images (product_id, storage_path, public_url, content_type, size_bytes, is_primary)
       SELECT id, 'products/1000/a.jpg', 'https://cdn/a.jpg', 'image/jpeg', 10, true FROM products WHERE ads_product_id = 1000`,
    );
    await t.sql().execute(`INSERT INTO listing_drafts (product_id, title) SELECT id, 'Título manual' FROM products WHERE ads_product_id = 1000`);

    data.products[0] = { ...data.products[0], descricao: "DESCRICAO NOVA", pesoBruto: 2 };
    await createJob(t.sql(), "PRODUCTS");
    await runAll();

    const [p] = await t.sql().query<{ nameCustom: string; nameOriginal: string }>(
      `SELECT name_custom AS "nameCustom", name_original AS "nameOriginal" FROM products WHERE ads_product_id = 1000`,
    );
    expect(p).toEqual({ nameCustom: "Oxidante 20 Volumes 950ml", nameOriginal: "DESCRICAO NOVA" });
    expect(await count("product_images")).toBe(1);
    const [d] = await t.sql().query<{ title: string }>(`SELECT title FROM listing_drafts`);
    expect(d.title).toBe("Título manual");
  });

  it("item inválido é registrado sem impedir os demais (PARTIALLY_COMPLETED)", async () => {
    const data = catalog(4);
    data.products.splice(1, 0, { descricao: "SEM ID" });
    mockAds(data);
    const job = await createJob(t.sql(), "PRODUCTS");
    await runAll();
    const done = (await getJob(t.sql(), job.id))!;
    expect(done).toMatchObject({ status: "PARTIALLY_COMPLETED", created: 4, failed: 1 });
    expect(done.errorSummary).toContain("INVALID_ITEM");
    const errors = await listJobErrors(t.sql(), job.id);
    expect(errors.items[0]).toMatchObject({ errorCode: "INVALID_ITEM", page: 1 });
    expect(await count("products")).toBe(4);
  });

  it("produtos inativos são importados e identificados", async () => {
    const data = catalog(2);
    data.products[1] = { ...data.products[1], inativo: true };
    mockAds(data);
    await createJob(t.sql(), "PRODUCTS");
    await runAll();
    const rows = await t.sql().query<{ inactive: boolean }>(`SELECT inactive FROM products ORDER BY ads_product_id`);
    expect(rows.map((r) => r.inactive)).toEqual([false, true]);
  });
});

describe("tabelas comerciais e preços", () => {
  it("importa tabelas e preços em múltiplas tabelas/filiais por produto; inativos preservados", async () => {
    const data = catalog(3);
    data.tables.push(table("H", "PROMOÇÃO PROFISSIONA", { inativo: true }));
    data.prices = [
      price(1000, "F", 88.2),
      price(1000, "G", 95.5),
      price(1000, "F", 87.9, { filialId: "02" }),
      price(1001, "F", 10, { inativo: true }),
      price(1002, "U", null),
    ];
    mockAds(data);
    await createJob(t.sql(), "PRODUCTS");
    await runAll();
    const job = await createJob(t.sql(), "PRICES");
    await runAll();

    expect(await getJob(t.sql(), job.id)).toMatchObject({ status: "COMPLETED", total: 5, processed: 5, created: 5 });
    expect(await count("price_tables")).toBe(4);
    const prices = await t.sql().query<{ ads: number; branch: string; code: string; price: string | null; inactive: boolean; ceiling: string }>(
      `SELECT ads_product_id AS ads, branch_id AS branch, price_table_code AS code, price::text AS price, inactive,
              ceiling_value::text AS ceiling
       FROM product_prices ORDER BY ads_product_id, price_table_code, branch_id`,
    );
    expect(prices).toEqual([
      { ads: 1000, branch: "01", code: "F", price: "88.2000", inactive: false, ceiling: "72.1467" },
      { ads: 1000, branch: "02", code: "F", price: "87.9000", inactive: false, ceiling: "72.1467" },
      { ads: 1000, branch: "01", code: "G", price: "95.5000", inactive: false, ceiling: "72.1467" },
      { ads: 1001, branch: "01", code: "F", price: "10.0000", inactive: true, ceiling: "72.1467" },
      { ads: 1002, branch: "01", code: "U", price: null, inactive: false, ceiling: "72.1467" },
    ]);
  });

  it("preço de produto não importado vira erro PRODUCT_NOT_IMPORTED (sem registro órfão)", async () => {
    const data = catalog(1);
    data.prices = [price(1000, "F", 50), price(999_999, "F", 20)];
    mockAds(data);
    await createJob(t.sql(), "PRODUCTS");
    await runAll();
    const job = await createJob(t.sql(), "PRICES");
    await runAll();
    expect(await getJob(t.sql(), job.id)).toMatchObject({ status: "PARTIALLY_COMPLETED", created: 1, failed: 1 });
    const errors = await listJobErrors(t.sql(), job.id);
    expect(errors.items[0]).toMatchObject({ errorCode: "PRODUCT_NOT_IMPORTED", externalProductId: 999_999 });
    expect(await count("product_prices")).toBe(1);
  });

  it("reimportar preços não duplica e detecta alterações", async () => {
    const data = catalog(1);
    data.prices = [price(1000, "F", 50), price(1000, "G", 60)];
    mockAds(data);
    await createJob(t.sql(), "PRODUCTS");
    await runAll();
    await createJob(t.sql(), "PRICES");
    await runAll();
    data.prices[0] = { ...data.prices[0], preco: 55 };
    const again = await createJob(t.sql(), "PRICES");
    await runAll();
    expect(await getJob(t.sql(), again.id)).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
    expect(await count("product_prices")).toBe(2);
  });
});

describe("estoque", () => {
  it("estoque por filial: zero é zero, ausência é desconhecido; ultVnd não é data de atualização", async () => {
    const data = catalog(3);
    data.stocks = [stock(1000, 3), stock(1000, 2, { filialId: "02" }), stock(1001, 0)];
    mockAds(data);
    await createJob(t.sql(), "PRODUCTS");
    await runAll();
    const job = await createJob(t.sql(), "STOCKS");
    await runAll();
    expect(await getJob(t.sql(), job.id)).toMatchObject({ status: "COMPLETED", created: 3 });
    const rows = await t.sql().query<{ ads: number; total: string | null; branches: number; lastSale: Date | null; fetched: Date | null }>(
      `SELECT p.ads_product_id AS ads, sum(s.quantity)::text AS total, count(s.id)::int AS branches,
              max(s.last_sale_at) AS "lastSale", max(s.fetched_at) AS fetched
       FROM products p LEFT JOIN product_stocks s ON s.product_id = p.id GROUP BY p.ads_product_id ORDER BY 1`,
    );
    expect(rows.map((r) => [r.ads, r.total, r.branches])).toEqual([
      [1000, "5.000", 2],
      [1001, "0.000", 1],
      [1002, null, 0],
    ]);
    expect(rows[0].lastSale?.toISOString()).toBe("2026-10-22T03:00:00.000Z");
    expect(rows[0].fetched!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("atualização seletiva usa o filtro ids em lotes", async () => {
    const data = catalog(5);
    data.stocks = data.products.map((p) => stock(p.produtoId as number, 1));
    const { calls } = mockAds(data);
    await createJob(t.sql(), "PRODUCTS");
    await runAll();
    await createJob(t.sql(), "STOCKS", { adsProductIds: [1001, 1003] });
    await runAll();
    const stockCalls = calls.filter((c) => c.resource === "estoques");
    expect(stockCalls.map((c) => c.ids)).toEqual([[1001, 1003]]);
    expect(await count("product_stocks")).toBe(2);
  });
});

describe("falhas, retentativas e recuperação", () => {
  it("falha transitória: retenta com backoff e conclui sem duplicar", async () => {
    const { calls } = mockAds(catalog(7), [{ resource: "produtos", page: 2, times: 2, status: 503 }]);
    const job = await createJob(t.sql(), "PRODUCTS");
    await runAll();
    expect(await getJob(t.sql(), job.id)).toMatchObject({ status: "COMPLETED", created: 7, attempts: 0 });
    expect(calls.filter((c) => c.resource === "produtos").map((c) => c.page)).toEqual([1, 2, 2, 2, 3]);
    expect(await count("products")).toBe(7);
  });

  it("após esgotar as tentativas a tarefa é interrompida, preservando o que já foi gravado, e pode ser retomada", async () => {
    const data = catalog(7);
    const { calls } = mockAds(data, [{ resource: "produtos", page: 2, times: MAX_ATTEMPTS, status: 500 }]);
    const job = await createJob(t.sql(), "PRODUCTS");
    await runAll();
    const failed = (await getJob(t.sql(), job.id))!;
    expect(failed.status).toBe("PARTIALLY_COMPLETED");
    expect(failed.cursor).toMatchObject({ page: 2 });
    expect(failed.errorSummary).toMatch(/Retomar/);
    expect(await count("products")).toBe(3); // página 1 preservada
    expect((await listJobErrors(t.sql(), job.id)).items[0].errorCode).toBe("ADS_SERVER");

    const { job: resumed, resumed: wasResumed } = await retryJob(t.sql(), job.id);
    expect(wasResumed).toBe(true);
    expect(resumed.id).toBe(job.id);
    await runAll();
    expect(await getJob(t.sql(), job.id)).toMatchObject({ status: "COMPLETED", processed: 7 });
    const pages = calls.filter((c) => c.resource === "produtos").map((c) => c.page);
    expect(pages.slice(-2)).toEqual([2, 3]); // retomou da página 2, não do início
    expect(await count("products")).toBe(7);
  });

  it("credencial inválida encerra como FAILED sem retentativas", async () => {
    const { calls } = mockAds(catalog(3));
    process.env.ADS_API_KEY = "errada";
    const job = await createJob(t.sql(), "PRODUCTS");
    await runAll();
    const done = (await getJob(t.sql(), job.id))!;
    expect(done.status).toBe("FAILED");
    expect((await listJobErrors(t.sql(), job.id)).items[0].errorCode).toBe("ADS_AUTH");
    expect(calls.length).toBe(1);
  });

  it("configuração ADS ausente encerra como FAILED (CONFIG_ERROR)", async () => {
    mockAds(catalog(1));
    delete process.env.ADS_CNPJ;
    const job = await createJob(t.sql(), "PRODUCTS");
    await runAll();
    expect(await getJob(t.sql(), job.id)).toMatchObject({ status: "FAILED" });
    expect((await listJobErrors(t.sql(), job.id)).items[0].errorCode).toBe("CONFIG_ERROR");
  });

  it("retoma após interrupção do worker (lease expirado) a partir do cursor salvo", async () => {
    const data = catalog(7);
    const { calls } = mockAds(data);
    const job = await createJob(t.sql(), "PRODUCTS");
    // Simula um worker que gravou a página 1 e morreu: tarefa RUNNING, cursor na página 2, lease vencido.
    await t.sql().execute(
      `UPDATE import_jobs SET status = 'RUNNING', cursor = '{"phase":"items","page":2,"chunk":0}', processed = 3, created = 3 WHERE id = $1::uuid`,
      [job.id],
    );
    await t.sql().execute(`INSERT INTO worker_leases (name, owner, lease_until) VALUES ('ads-import', 'morto', now() - interval '1 minute')`);
    await runAll();
    expect(calls.filter((c) => c.resource === "produtos").map((c) => c.page)).toEqual([2, 3]);
    expect(await getJob(t.sql(), job.id)).toMatchObject({ status: "COMPLETED", processed: 7 });
  });
});

describe("concorrência", () => {
  it("impede duas importações ativas do mesmo tipo", async () => {
    await createJob(t.sql(), "PRODUCTS");
    await expect(createJob(t.sql(), "PRODUCTS")).rejects.toBeInstanceOf(JobConflictError);
    await expect(createJob(t.sql(), "STOCKS")).resolves.toMatchObject({ status: "PENDING" });
  });

  it("um segundo worker não processa enquanto o lease está ativo", async () => {
    mockAds(catalog(3));
    await createJob(t.sql(), "PRODUCTS");
    expect(await acquireLease(t.sql(), "outro-worker")).toBe(true);
    const r = await processJobs({ sql: t.sql(), budgetMs: 1000, sleep: noSleep });
    expect(r.busy).toBe(true);
    expect(await count("products")).toBe(0);
  });

  it("tarefa cancelada não é processada", async () => {
    const { calls } = mockAds(catalog(3));
    const job = await createJob(t.sql(), "PRODUCTS");
    await cancelJob(t.sql(), job.id);
    await runAll();
    expect(calls).toHaveLength(0);
    expect((await getJob(t.sql(), job.id))!.status).toBe("CANCELED");
    // após o cancelamento, uma nova importação do mesmo tipo é permitida
    await expect(createJob(t.sql(), "PRODUCTS")).resolves.toBeTruthy();
  });

  it("tarefas são processadas em ordem, uma por vez", async () => {
    const data = catalog(4);
    data.stocks = [stock(1000, 1)];
    const { calls } = mockAds(data);
    await createJob(t.sql(), "PRODUCTS");
    await createJob(t.sql(), "STOCKS");
    await runAll();
    const order = calls.map((c) => c.resource).filter((r) => r === "produtos" || r === "estoques");
    expect(order).toEqual(["produtos", "produtos", "estoques"]);
    expect(await count("product_stocks")).toBe(1);
  });
});
