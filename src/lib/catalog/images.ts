import "server-only";
import { randomUUID } from "node:crypto";
import { logger } from "../logger";
import type { Sql } from "../sql";
import { getStorage, MAX_IMAGE_BYTES, type ObjectStorage } from "../storage/supabase";

export const MAX_IMAGES_PER_PRODUCT = 12;
/** Recomendação do Mercado Livre para boa exibição; abaixo disso apenas avisamos. */
export const RECOMMENDED_MIN_SIDE = 500;

export interface ProductImage {
  id: number;
  productId: number;
  storagePath: string;
  publicUrl: string;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  originalFilename: string | null;
  position: number;
  isPrimary: boolean;
  createdAt: Date;
}

const IMAGE_COLUMNS = `id, product_id AS "productId", storage_path AS "storagePath", public_url AS "publicUrl",
  content_type AS "contentType", size_bytes AS "sizeBytes", width, height, original_filename AS "originalFilename",
  position, is_primary AS "isPrimary", created_at AS "createdAt"`;

export class ImageValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface DetectedImage {
  contentType: "image/jpeg" | "image/png";
  ext: "jpg" | "png";
  width: number | null;
  height: number | null;
}

/**
 * Identifica o formato pelos bytes (não confia na extensão nem no Content-Type do navegador).
 * Aceita apenas JPEG e PNG — formatos aceitos pelo Mercado Livre. SVG/HTML/executáveis são recusados.
 */
export function detectImage(bytes: Uint8Array): DetectedImage | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // IHDR: largura/altura em 16..23
    return { contentType: "image/png", ext: "png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", ext: "jpg", ...jpegSize(bytes) };
  }
  return null;
}

function jpegSize(bytes: Uint8Array): { width: number | null; height: number | null } {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    // SOF0..SOF15, exceto DHT (C4), JPG (C8) e DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    if (len < 2) break;
    i += 2 + len;
  }
  return { width: null, height: null };
}

export function validateImage(bytes: Uint8Array): DetectedImage {
  if (bytes.length === 0) throw new ImageValidationError("empty_file", "Arquivo vazio.");
  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageValidationError("file_too_large", `Imagem acima de ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
  const detected = detectImage(bytes);
  if (!detected) throw new ImageValidationError("unsupported_type", "Formato não suportado. Envie JPEG ou PNG.");
  if (detected.width === 0 || detected.height === 0) throw new ImageValidationError("invalid_image", "Imagem corrompida ou sem dimensões.");
  if ((detected.width ?? 0) > 20_000 || (detected.height ?? 0) > 20_000) throw new ImageValidationError("invalid_image", "Dimensões de imagem fora do limite.");
  return detected;
}

function safeFilename(name: string | undefined): string | null {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^\p{L}\p{N}._ -]/gu, "").slice(0, 120).trim();
  return cleaned || null;
}

export async function listImages(sql: Sql, productId: number): Promise<ProductImage[]> {
  return sql.query<ProductImage>(
    `SELECT ${IMAGE_COLUMNS} FROM product_images WHERE product_id = $1::int ORDER BY position, id`,
    [productId],
  );
}

export interface UploadInput {
  bytes: Uint8Array;
  filename?: string;
}

/**
 * Valida, envia ao storage e registra. O registro só é criado após o upload; se a gravação no banco
 * falhar, o objeto enviado é removido (compensação).
 */
export async function addImage(sql: Sql, productId: number, input: UploadInput, storage: ObjectStorage = getStorage()): Promise<ProductImage> {
  const detected = validateImage(input.bytes);

  const [product] = await sql.query<{ adsProductId: number; images: number }>(
    `SELECT ads_product_id AS "adsProductId", (SELECT count(*)::int FROM product_images WHERE product_id = p.id) AS images
     FROM products p WHERE id = $1::int`,
    [productId],
  );
  if (!product) throw new ImageValidationError("product_not_found", "Produto não encontrado.");
  if (product.images >= MAX_IMAGES_PER_PRODUCT) {
    throw new ImageValidationError("too_many_images", `Limite de ${MAX_IMAGES_PER_PRODUCT} imagens por produto.`);
  }

  const path = `products/${product.adsProductId}/${randomUUID()}.${detected.ext}`;
  await storage.upload(path, input.bytes, detected.contentType);

  try {
    return await sql.transaction(async (tx) => {
      // Serializa inclusões concorrentes do mesmo produto (posição e imagem principal).
      await tx.query(`SELECT id FROM products WHERE id = $1::int FOR UPDATE`, [productId]);
      const [{ count, next }] = await tx.query<{ count: number; next: number }>(
        `SELECT count(*)::int AS count, COALESCE(max(position) + 1, 0)::int AS next FROM product_images WHERE product_id = $1::int`,
        [productId],
      );
      if (count >= MAX_IMAGES_PER_PRODUCT) {
        throw new ImageValidationError("too_many_images", `Limite de ${MAX_IMAGES_PER_PRODUCT} imagens por produto.`);
      }
      const [row] = await tx.query<ProductImage>(
        `INSERT INTO product_images (product_id, storage_path, public_url, content_type, size_bytes, width, height,
           original_filename, position, is_primary)
         VALUES ($1::int, $2::text, $3::text, $4::text, $5::int, $6::int, $7::int, $8::text, $9::int,
           NOT EXISTS (SELECT 1 FROM product_images WHERE product_id = $1::int AND is_primary))
         RETURNING ${IMAGE_COLUMNS}`,
        [productId, path, storage.publicUrl(path), detected.contentType, input.bytes.length, detected.width, detected.height,
          safeFilename(input.filename), next],
      );
      return row;
    });
  } catch (err) {
    await storage.remove(path).catch((e) => logger.warn("Falha ao remover objeto após erro de gravação", { path, err: e }));
    throw err;
  }
}

/** Remove a imagem. Se era a principal, a próxima da galeria assume. */
export async function deleteImage(sql: Sql, productId: number, imageId: number, storage: ObjectStorage = getStorage()): Promise<boolean> {
  const removed = await sql.transaction(async (tx) => {
    const [row] = await tx.query<{ storagePath: string; isPrimary: boolean }>(
      `DELETE FROM product_images WHERE id = $1::int AND product_id = $2::int
       RETURNING storage_path AS "storagePath", is_primary AS "isPrimary"`,
      [imageId, productId],
    );
    if (!row) return null;
    if (row.isPrimary) {
      await tx.execute(
        `UPDATE product_images SET is_primary = true
         WHERE id = (SELECT id FROM product_images WHERE product_id = $1::int ORDER BY position, id LIMIT 1)`,
        [productId],
      );
    }
    // Sem imagens o rascunho deixa de estar pronto para publicação.
    await tx.execute(
      `UPDATE listing_drafts SET status = 'DRAFT', updated_at = now()
       WHERE product_id = $1::int AND status = 'READY' AND NOT EXISTS (SELECT 1 FROM product_images WHERE product_id = $1::int)`,
      [productId],
    );
    return row;
  });
  if (!removed) return false;
  try {
    await storage.remove(removed.storagePath);
  } catch (err) {
    // O registro já saiu do catálogo; o arquivo órfão não é exibido e pode ser limpo depois.
    logger.warn("Imagem removida do catálogo, mas não do armazenamento", { path: removed.storagePath, err });
  }
  return true;
}

/** Reordena a galeria e/ou define a imagem principal. `order` deve conter todas as imagens do produto. */
export async function arrangeImages(sql: Sql, productId: number, opts: { order?: number[]; primaryId?: number }): Promise<ProductImage[]> {
  return sql.transaction(async (tx) => {
    const current = await tx.query<{ id: number }>(`SELECT id FROM product_images WHERE product_id = $1::int FOR UPDATE`, [productId]);
    const ids = new Set(current.map((r) => r.id));

    if (opts.order) {
      const unique = new Set(opts.order);
      if (unique.size !== opts.order.length || unique.size !== ids.size || ![...unique].every((id) => ids.has(id))) {
        throw new ImageValidationError("invalid_order", "A ordem deve listar exatamente as imagens do produto.");
      }
      await tx.execute(
        `UPDATE product_images i SET position = o.pos
         FROM (SELECT * FROM unnest($2::int[]) WITH ORDINALITY AS t(id, pos)) o
         WHERE i.id = o.id AND i.product_id = $1::int`,
        [productId, opts.order],
      );
    }
    if (opts.primaryId !== undefined) {
      if (!ids.has(opts.primaryId)) throw new ImageValidationError("image_not_found", "Imagem não encontrada neste produto.");
      await tx.execute(`UPDATE product_images SET is_primary = false WHERE product_id = $1::int AND is_primary`, [productId]);
      await tx.execute(`UPDATE product_images SET is_primary = true WHERE id = $1::int`, [opts.primaryId]);
    }
    return listImages(tx, productId);
  });
}
