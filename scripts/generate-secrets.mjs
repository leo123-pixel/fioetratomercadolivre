// Gera TOKEN_ENCRYPTION_KEY e SESSION_SECRET aleatórios para colar no .env.local / Vercel.
import { randomBytes } from "node:crypto";

console.log("TOKEN_ENCRYPTION_KEY=" + randomBytes(32).toString("base64"));
console.log("SESSION_SECRET=" + randomBytes(48).toString("base64url"));
