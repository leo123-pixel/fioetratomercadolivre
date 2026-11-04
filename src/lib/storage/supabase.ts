import "server-only";
import { ConfigError } from "../env";

/**
 * Armazenamento de imagens. Implementação: Supabase Storage (REST), bucket público para que o
 * Mercado Livre consiga baixar as imagens na fase de publicação. O caminho do objeto (storage_path)
 * é guardado separado da URL pública de entrega (public_url).
 *
 * A chave service role fica só no servidor e nunca é enviada ao navegador.
 */
export interface ObjectStorage {
  upload(path: string, body: Uint8Array, contentType: string): Promise<void>;
  remove(path: string): Promise<void>;
  publicUrl(path: string): string;
}

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png"] as const;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // abaixo do limite de 4,5 MB do corpo de requisição na Vercel

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

interface SupabaseConfig {
  url: string;
  key: string;
  bucket: string;
}

function readConfig(): SupabaseConfig {
  const missing = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter((k) => !process.env[k]?.trim());
  if (missing.length) throw new ConfigError(`Variáveis de ambiente ausentes: ${missing.join(", ")}`);
  let url: URL;
  try {
    url = new URL(process.env.SUPABASE_URL!.trim());
  } catch {
    throw new ConfigError("SUPABASE_URL não é uma URL válida");
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new ConfigError("SUPABASE_URL deve usar HTTPS");
  }
  const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || "product-images";
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(bucket)) throw new ConfigError("SUPABASE_STORAGE_BUCKET inválido");
  return { url: url.origin, key: process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), bucket };
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

class SupabaseStorage implements ObjectStorage {
  private bucketReady = false;

  constructor(
    private readonly cfg: SupabaseConfig,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private headers(extra: Record<string, string> = {}) {
    return { apikey: this.cfg.key, Authorization: `Bearer ${this.cfg.key}`, ...extra };
  }

  /** Cria o bucket público na primeira utilização, se ainda não existir. */
  private async ensureBucket() {
    if (this.bucketReady) return;
    const res = await this.fetchImpl(`${this.cfg.url}/storage/v1/bucket/${this.cfg.bucket}`, { headers: this.headers(), cache: "no-store" });
    if (res.ok) {
      this.bucketReady = true;
      return;
    }
    const created = await this.fetchImpl(`${this.cfg.url}/storage/v1/bucket`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        id: this.cfg.bucket,
        name: this.cfg.bucket,
        public: true,
        file_size_limit: MAX_IMAGE_BYTES,
        allowed_mime_types: [...ALLOWED_IMAGE_TYPES],
      }),
    });
    // 409/400 "already exists" em corrida entre instâncias também é aceitável.
    if (!created.ok && created.status !== 409) {
      const text = (await created.text().catch(() => "")).slice(0, 200);
      if (!/already exists/i.test(text)) throw new StorageError(`Não foi possível preparar o bucket de imagens (HTTP ${created.status})`);
    }
    this.bucketReady = true;
  }

  async upload(path: string, body: Uint8Array, contentType: string) {
    await this.ensureBucket();
    const res = await this.fetchImpl(`${this.cfg.url}/storage/v1/object/${this.cfg.bucket}/${encodePath(path)}`, {
      method: "POST",
      headers: this.headers({ "content-type": contentType, "x-upsert": "false", "cache-control": "max-age=31536000" }),
      body: Buffer.from(body),
    });
    if (!res.ok) throw new StorageError(`Falha ao enviar a imagem ao armazenamento (HTTP ${res.status})`);
  }

  async remove(path: string) {
    const res = await this.fetchImpl(`${this.cfg.url}/storage/v1/object/${this.cfg.bucket}`, {
      method: "DELETE",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ prefixes: [path] }),
    });
    if (!res.ok) throw new StorageError(`Falha ao remover a imagem do armazenamento (HTTP ${res.status})`);
  }

  publicUrl(path: string) {
    return `${this.cfg.url}/storage/v1/object/public/${this.cfg.bucket}/${encodePath(path)}`;
  }
}

let storage: ObjectStorage | null = null;

export function getStorage(): ObjectStorage {
  if (!storage) storage = new SupabaseStorage(readConfig());
  return storage;
}

/** Somente para testes. */
export function setStorageForTesting(s: ObjectStorage | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("setStorageForTesting só pode ser usado em testes");
  storage = s;
}

export function createSupabaseStorageForTesting(fetchImpl: typeof fetch): ObjectStorage {
  return new SupabaseStorage(readConfig(), fetchImpl);
}
