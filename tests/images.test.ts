import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { DELETE as deleteRoute } from "@/app/api/products/[id]/images/[imageId]/route";
import { PATCH as arrangeRoute, POST as uploadRoute } from "@/app/api/products/[id]/images/route";
import { detectImage, MAX_IMAGES_PER_PRODUCT } from "@/lib/catalog/images";
import { createSupabaseStorageForTesting, setStorageForTesting, type ObjectStorage } from "@/lib/storage/supabase";
import { BASE, makeRequest } from "./helpers/fixtures";
import { adminCookies } from "./helpers/meli-mock";
import { useTestDatabase } from "./helpers/pg";

const t = useTestDatabase();
const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });

function png(width = 800, height = 800, extra = 64): Uint8Array {
  const bytes = new Uint8Array(24 + extra);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpeg(width = 640, height = 480): Uint8Array {
  // SOI, APP0 (len 16), SOF0 (len 17) com altura/largura
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, ...new Array(10).fill(0)];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

class FakeStorage implements ObjectStorage {
  objects = new Map<string, { contentType: string; size: number }>();
  failUpload = false;
  async upload(path: string, body: Uint8Array, contentType: string) {
    if (this.failUpload) {
      const { StorageError } = await import("@/lib/storage/supabase");
      throw new StorageError("Falha ao enviar a imagem ao armazenamento (HTTP 500)");
    }
    this.objects.set(path, { contentType, size: body.length });
  }
  async remove(path: string) {
    this.objects.delete(path);
  }
  publicUrl(path: string) {
    return `https://cdn.test/${path}`;
  }
}

async function seedProduct(ads = 1804): Promise<number> {
  const [{ id }] = await t.sql().query<{ id: number }>(
    `INSERT INTO products (ads_product_id, name_original, raw_payload) VALUES ($1, 'PRODUTO', '{}') RETURNING id`,
    [ads],
  );
  return id;
}

function uploadRequest(productId: number, files: { bytes: Uint8Array; name: string; type?: string }[], headers: Record<string, string> = { origin: BASE }) {
  const form = new FormData();
  for (const f of files) form.append("file", new Blob([Buffer.from(f.bytes)], { type: f.type ?? "image/png" }), f.name);
  const h = new Headers(headers);
  h.set("cookie", Object.entries(adminCookies()).map(([k, v]) => `${k}=${v}`).join("; "));
  return new NextRequest(new URL(`/api/products/${productId}/images`, BASE), { method: "POST", body: form, headers: h });
}

async function upload(productId: number, files: { bytes: Uint8Array; name: string; type?: string }[]) {
  const res = await uploadRoute(uploadRequest(productId, files), ctx({ id: String(productId) }));
  return { status: res.status, body: await res.json() };
}

describe("detecção de formato pelos bytes", () => {
  it("reconhece PNG e JPEG com dimensões; recusa o resto", () => {
    expect(detectImage(png(1200, 900))).toMatchObject({ contentType: "image/png", width: 1200, height: 900 });
    expect(detectImage(jpeg(640, 480))).toMatchObject({ contentType: "image/jpeg", width: 640, height: 480 });
    expect(detectImage(new TextEncoder().encode("<svg onload=alert(1)></svg>"))).toBeNull();
    expect(detectImage(new TextEncoder().encode("GIF89a......"))).toBeNull();
  });
});

describe("upload e gestão de imagens", () => {
  it("envia, registra caminho e URL pública separados, e define a primeira como principal", async () => {
    const storage = new FakeStorage();
    setStorageForTesting(storage);
    const id = await seedProduct();
    const first = await upload(id, [{ bytes: png(), name: "frente.png" }]);
    expect(first.status).toBe(201);
    const img = first.body.uploaded[0];
    expect(img.storagePath).toMatch(/^products\/1804\/[0-9a-f-]{36}\.png$/);
    expect(img.publicUrl).toBe(`https://cdn.test/${img.storagePath}`);
    expect(img).toMatchObject({ isPrimary: true, contentType: "image/png", width: 800, height: 800, originalFilename: "frente.png" });
    expect(storage.objects.get(img.storagePath)?.contentType).toBe("image/png");

    const second = await upload(id, [{ bytes: jpeg(300, 300), name: "verso.jpg", type: "image/jpeg" }]);
    expect(second.body.uploaded[0]).toMatchObject({ isPrimary: false, position: 1, contentType: "image/jpeg" });
    expect(second.body.warnings[0].message).toMatch(/500px/);
  });

  it("recusa arquivo disfarçado, sem enviar ao armazenamento", async () => {
    const storage = new FakeStorage();
    setStorageForTesting(storage);
    const id = await seedProduct();
    const res = await upload(id, [{ bytes: new TextEncoder().encode("<html><script>x</script></html>"), name: "foto.png" }]);
    expect(res.status).toBe(422);
    expect(res.body.rejected[0].code).toBe("unsupported_type");
    expect(storage.objects.size).toBe(0);
    expect(await t.sql().query(`SELECT 1 FROM product_images`)).toHaveLength(0);
  });

  it("recusa arquivo acima de 4 MB e respeita o limite de imagens por produto", async () => {
    setStorageForTesting(new FakeStorage());
    const id = await seedProduct();
    const big = await upload(id, [{ bytes: png(800, 800, 4 * 1024 * 1024), name: "grande.png" }]);
    expect(big.status).toBe(422);
    expect(big.body.rejected[0].code).toBe("file_too_large");

    for (let i = 0; i < MAX_IMAGES_PER_PRODUCT; i++) {
      await t.sql().execute(
        `INSERT INTO product_images (product_id, storage_path, public_url, content_type, size_bytes, position) VALUES ($1, $2, 'u', 'image/png', 1, $3)`,
        [id, `x/${i}.png`, i],
      );
    }
    const over = await upload(id, [{ bytes: png(), name: "mais.png" }]);
    expect(over.body.rejected[0].code).toBe("too_many_images");
  });

  it("falha no armazenamento não deixa registro no banco (502)", async () => {
    const storage = new FakeStorage();
    storage.failUpload = true;
    setStorageForTesting(storage);
    const id = await seedProduct();
    const res = await upload(id, [{ bytes: png(), name: "a.png" }]);
    expect(res.status).toBe(502);
    expect(await t.sql().query(`SELECT 1 FROM product_images`)).toHaveLength(0);
  });

  it("reordena, troca a principal e, ao excluir a principal, promove a próxima", async () => {
    const storage = new FakeStorage();
    setStorageForTesting(storage);
    const id = await seedProduct();
    const ids: number[] = [];
    for (const name of ["a.png", "b.png", "c.png"]) ids.push((await upload(id, [{ bytes: png(), name }])).body.uploaded[0].id);

    const arranged = await arrangeRoute(
      makeRequest(`/api/products/${id}/images`, { method: "PATCH", cookies: adminCookies(), headers: { origin: BASE }, body: { order: [ids[2], ids[0], ids[1]], primaryId: ids[2] } }),
      ctx({ id: String(id) }),
    );
    const { images } = await arranged.json();
    expect(images.map((i: { id: number }) => i.id)).toEqual([ids[2], ids[0], ids[1]]);
    expect(images.filter((i: { isPrimary: boolean }) => i.isPrimary).map((i: { id: number }) => i.id)).toEqual([ids[2]]);

    const badOrder = await arrangeRoute(
      makeRequest(`/api/products/${id}/images`, { method: "PATCH", cookies: adminCookies(), headers: { origin: BASE }, body: { order: [ids[0]] } }),
      ctx({ id: String(id) }),
    );
    expect(badOrder.status).toBe(422);

    const path = images[0].storagePath;
    const del = await deleteRoute(
      makeRequest(`/api/products/${id}/images/${ids[2]}`, { method: "DELETE", cookies: adminCookies(), headers: { origin: BASE } }),
      ctx({ id: String(id), imageId: String(ids[2]) }),
    );
    expect(del.status).toBe(200);
    expect(storage.objects.has(path)).toBe(false);
    const rest = await t.sql().query<{ id: number; primary: boolean }>(`SELECT id, is_primary AS primary FROM product_images ORDER BY position`);
    expect(rest).toEqual([
      { id: ids[0], primary: true },
      { id: ids[1], primary: false },
    ]);
  });

  it("substitui uma imagem mantendo posição e principal, e remove o arquivo antigo", async () => {
    const storage = new FakeStorage();
    setStorageForTesting(storage);
    const id = await seedProduct();
    const first = (await upload(id, [{ bytes: png(), name: "a.png" }])).body.uploaded[0];
    await upload(id, [{ bytes: png(), name: "b.png" }]);
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(jpeg(900, 900))], { type: "image/jpeg" }), "nova.jpg");
    form.append("replaceImageId", String(first.id));
    const h = new Headers({ origin: BASE, cookie: Object.entries(adminCookies()).map(([k, v]) => `${k}=${v}`).join("; ") });
    const res = await uploadRoute(new NextRequest(new URL(`/api/products/${id}/images`, BASE), { method: "POST", body: form, headers: h }), ctx({ id: String(id) }));
    expect(res.status).toBe(201);
    const replaced = (await res.json()).uploaded[0];
    expect(replaced).toMatchObject({ isPrimary: true, position: first.position, contentType: "image/jpeg", width: 900 });
    expect(storage.objects.has(first.storagePath)).toBe(false);
    expect(await t.sql().query(`SELECT 1 FROM product_images`)).toHaveLength(2);
  });

  it("imagens continuam vinculadas após reimportação e rascunho pronto volta a rascunho sem imagens", async () => {
    setStorageForTesting(new FakeStorage());
    const id = await seedProduct();
    const imgId = (await upload(id, [{ bytes: png(), name: "a.png" }])).body.uploaded[0].id;
    await t.sql().execute(`INSERT INTO listing_drafts (product_id, title, listing_price, listing_quantity, status) VALUES ($1, 'T', 10, 1, 'READY')`, [id]);
    await deleteRoute(
      makeRequest(`/api/products/${id}/images/${imgId}`, { method: "DELETE", cookies: adminCookies(), headers: { origin: BASE } }),
      ctx({ id: String(id), imageId: String(imgId) }),
    );
    const [d] = await t.sql().query<{ status: string }>(`SELECT status FROM listing_drafts`);
    expect(d.status).toBe("DRAFT");
  });

  it("exige sessão e mesma origem", async () => {
    setStorageForTesting(new FakeStorage());
    const id = await seedProduct();
    const anon = new NextRequest(new URL(`/api/products/${id}/images`, BASE), { method: "POST", body: new FormData(), headers: { origin: BASE } });
    expect((await uploadRoute(anon, ctx({ id: String(id) }))).status).toBe(401);
    const csrf = await uploadRoute(uploadRequest(id, [{ bytes: png(), name: "a.png" }], { origin: "https://atacante.example" }), ctx({ id: String(id) }));
    expect(csrf.status).toBe(403);
  });
});

describe("Supabase Storage (REST)", () => {
  it("cria o bucket público quando ausente, envia com a chave só no cabeçalho e gera URL pública", async () => {
    const calls: { url: string; method: string; headers: Headers; body?: unknown }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body });
      if (url.endsWith("/storage/v1/bucket/product-images")) return new Response("{}", { status: 404 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const storage = createSupabaseStorageForTesting(fetchImpl);
    await storage.upload("products/1804/a b.png", png(), "image/png");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://storage.test/storage/v1/bucket/product-images",
      "POST https://storage.test/storage/v1/bucket",
      "POST https://storage.test/storage/v1/object/product-images/products/1804/a%20b.png",
    ]);
    expect(JSON.parse(String(calls[1].body))).toMatchObject({ id: "product-images", public: true, allowed_mime_types: ["image/jpeg", "image/png"] });
    expect(calls[2].headers.get("apikey")).toBe("test-service-role-NAO-REAL");
    expect(calls[2].headers.get("content-type")).toBe("image/png");
    expect(calls[2].url).not.toContain("service-role");
    expect(storage.publicUrl("products/1804/a.png")).toBe("https://storage.test/storage/v1/object/public/product-images/products/1804/a.png");
  });
});
