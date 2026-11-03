// Build usado na Vercel: aplica migrations (se DATABASE_URL existir) e roda o build do Next.
import { execSync } from "node:child_process";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });

run("npx prisma generate");

if (process.env.DATABASE_URL) {
  run("npx prisma migrate deploy");
} else {
  console.warn("[vercel-build] DATABASE_URL ausente: migrations NÃO aplicadas. O fluxo OAuth não funcionará até configurar o banco.");
}

run("npx next build");
