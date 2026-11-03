// Gera o valor de ADMIN_PASSWORD_HASH (scrypt). A senha é lida do terminal e nunca gravada.
// Uso: npm run admin:hash
import { randomBytes, scrypt } from "node:crypto";
import { createInterface } from "node:readline";

const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 64;

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

const password = process.env.ADMIN_PASSWORD_INPUT ?? (await ask("Senha do administrador (mín. 12 caracteres): "));
if (!password || password.length < 12) {
  console.error("Senha muito curta. Use pelo menos 12 caracteres.");
  process.exit(1);
}

const salt = randomBytes(16);
scrypt(password, salt, KEYLEN, { N, r, p }, (err, key) => {
  if (err) throw err;
  console.log("\nADMIN_PASSWORD_HASH=" + ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$"));
});
