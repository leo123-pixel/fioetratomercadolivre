// Teste REAL de leitura na ADS (homologação), somente GET. Não grava nada no banco nem na ADS.
// Uso (com as variáveis no ambiente ou em .env.local):
//   node --env-file=.env.local scripts/ads-smoke.mjs
// Imprime apenas contagens e campos estruturais — nunca a chave da API.

const base = (process.env.ADS_API_BASE_URL || "https://hom.adsapi.com.br").replace(/\/+$/, "");
const key = process.env.ADS_API_KEY?.trim();
const ua = process.env.ADS_USER_AGENT?.trim();
const cnpj = process.env.ADS_CNPJ?.replace(/\D/g, "");
const missing = [!key && "ADS_API_KEY", !ua && "ADS_USER_AGENT", !cnpj && "ADS_CNPJ"].filter(Boolean);
if (missing.length) {
  console.error(`Variáveis ausentes: ${missing.join(", ")}`);
  process.exit(1);
}

async function get(path) {
  const started = Date.now();
  const res = await fetch(`${base}/api/v1/${cnpj}/${path}`, {
    headers: { "x-api-key": key, "User-Agent": ua, Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  const ms = Date.now() - started;
  const body = await res.json().catch(() => null);
  return { status: res.status, ms, body };
}

function summarizePage(name, r) {
  if (r.status !== 200 || !r.body || !Array.isArray(r.body.items)) {
    console.log(`✗ ${name}: HTTP ${r.status} (${r.ms} ms)`);
    return null;
  }
  const { page, pageSize, total, hasNext, items } = r.body;
  console.log(`✓ ${name}: HTTP 200 (${r.ms} ms) page=${page} pageSize=${pageSize} total=${total} hasNext=${hasNext} itens=${items.length}`);
  if (items[0]) console.log(`  campos: ${Object.keys(items[0]).join(", ")}`);
  return r.body;
}

const produtos = summarizePage("produtos", await get("produtos?page=1&pageSize=5"));
const tabelas = await get("tabelas");
console.log(
  tabelas.status === 200 && Array.isArray(tabelas.body)
    ? `✓ tabelas: ${tabelas.body.length} (${tabelas.body.map((t) => `${t.codigo}${t.inativo ? "*" : ""}`).join(", ")}) (* = inativa)`
    : `✗ tabelas: HTTP ${tabelas.status}`,
);
summarizePage("tabela-precos-itens", await get("tabela-precos-itens?page=1&pageSize=5"));
const firstId = produtos?.items?.[0]?.produtoId;
summarizePage(`estoques (ids=${firstId ?? "-"})`, await get(`estoques?page=1&pageSize=5${firstId ? `&ids=${firstId}` : ""}`));
summarizePage("estoques (todos)", await get("estoques?page=1&pageSize=5"));
for (const list of ["fornecedores", "divisoes"]) {
  const r = await get(list);
  console.log(r.status === 200 && Array.isArray(r.body) ? `✓ ${list}: ${r.body.length}` : `✗ ${list}: HTTP ${r.status}`);
}
