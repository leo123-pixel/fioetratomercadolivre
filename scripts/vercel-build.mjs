// Build usado na Vercel: aplica migrations (se DATABASE_URL existir) e roda o build do Next.
import { execSync } from "node:child_process";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

run("npx prisma generate");

/**
 * URL usada só pelo `migrate deploy`. As migrations exigem o modo sessão do pooler do Supabase
 * (porta 5432); o app em produção pode usar o modo transação (porta 6543), próprio para serverless.
 * Ordem: DIRECT_URL, se existir; senão a DATABASE_URL com a porta 6543 trocada por 5432.
 */
function migrationUrl() {
  if (process.env.DIRECT_URL) return process.env.DIRECT_URL;
  const raw = process.env.DATABASE_URL;
  try {
    const url = new URL(raw);
    if (url.port === "6543") {
      url.port = "5432";
      url.searchParams.delete("pgbouncer");
      url.searchParams.delete("connection_limit");
      console.log("[vercel-build] DATABASE_URL usa o modo transação (6543); migrations pelo modo sessão (5432).");
    }
    return url.toString();
  } catch {
    return raw;
  }
}

if (process.env.DATABASE_URL) {
  const migrateEnv = { ...process.env, DATABASE_URL: migrationUrl() };
  // O pooler do Supabase em modo sessão tem limite de clientes (EMAXCONNSESSION). Quando as funções
  // em execução ocupam todas as vagas, a conexão do build é recusada; é transitório, então tenta de novo.
  const attempts = 4;
  for (let i = 1; ; i++) {
    let output = "";
    try {
      output = execSync("npx prisma migrate deploy", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: migrateEnv });
      process.stdout.write(output);
      break;
    } catch (err) {
      output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      process.stderr.write(output);
      const poolFull = output.includes("EMAXCONNSESSION");
      if (i < attempts) {
        console.warn(`[vercel-build] migrate deploy falhou (tentativa ${i}/${attempts}); nova tentativa em ${15 * i}s.`);
        await sleep(15_000 * i);
        continue;
      }
      // Pool cheio = a conexão nem foi aberta, nenhuma migration foi aplicada pela metade.
      // Segue o build (a versão nova reduz as conexões por função); qualquer outro erro interrompe.
      if (poolFull) {
        console.warn("[vercel-build] ATENÇÃO: pooler do Supabase cheio; migrations NÃO verificadas neste build. Se houver migration nova, faça redeploy.");
        break;
      }
      throw err;
    }
  }
} else {
  console.warn("[vercel-build] DATABASE_URL ausente: migrations NÃO aplicadas. O fluxo OAuth não funcionará até configurar o banco.");
}

run("npx next build");
