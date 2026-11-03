# Fio & Trato · Integrador ADS ↔ Mercado Livre

Etapa atual: **autenticação OAuth 2.0 (Authorization Code + PKCE S256) com o Mercado Livre (MLB)**.
Importação ADS, publicação de anúncios, pedidos, preço e estoque ainda **não** fazem parte do escopo.

Stack: Next.js 15 (App Router) · TypeScript · Prisma + PostgreSQL · Vercel · Vitest.

## Rotas

| Método | Rota | Acesso | Função |
|---|---|---|---|
| GET | `/api/auth/mercadolivre` | admin | Gera `state` + PKCE, grava no banco e redireciona para `auth.mercadolivre.com.br/authorization` |
| GET | `/api/auth/mercadolivre/callback` | admin + state | Valida `state` (expiração, binding com o navegador, uso único), troca o `code`, confirma `/users/me`, grava tokens criptografados |
| GET | `/api/mercadolivre/connection` | admin | Status da conexão (sem credenciais) |
| POST | `/api/mercadolivre/connection/test` | admin + mesma origem | Chamada autenticada a `/users/me` (renova o token se necessário) |
| POST | `/api/mercadolivre/disconnect` | admin + mesma origem + `{"confirm":"DESCONECTAR"}` | Revoga no ML (`DELETE /users/{id}/applications/{app_id}`) e apaga os tokens locais |
| POST | `/api/admin/login` · `/api/admin/logout` | mesma origem | Sessão do administrador (cookie `__Host-` HttpOnly, Secure, SameSite=Lax, 8h) |
| — | `/configuracoes/integracoes/mercadolivre` | admin | Painel |
| — | `/login` | público | Login do administrador |

## Estrutura

```
prisma/schema.prisma            OAuthState, MeliConnection, AdminLoginThrottle
prisma/migrations/              migration inicial (SQL)
src/lib/env.ts                  validação de env (HTTPS obrigatório fora de localhost)
src/lib/crypto.ts               AES-256-GCM com AAD por finalidade, PKCE, hashes
src/lib/logger.ts               logs JSON sanitizados (tokens/códigos/secrets redigidos)
src/lib/auth/                   senha scrypt, sessão HMAC assinada
src/lib/store/                  persistência (Prisma) com operações atômicas condicionais
src/lib/meli/client.ts          chamadas HTTP ao Mercado Livre
src/lib/meli/oauth.ts           início e callback do OAuth
src/lib/meli/tokens.ts          getValidAccessToken(): renovação com lease distribuído
src/lib/meli/connection.ts      resumo, teste /users/me, desconexão
src/app/...                     rotas e páginas
tests/                          testes automatizados (Vitest, fetch e banco simulados)
```

## Segurança (resumo)

- **CSRF/state**: `state` aleatório de 256 bits; só o SHA-256 vai para o banco; expira em 10 min; consumo por `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now()` (uso único, seguro entre instâncias); amarrado a um nonce em cookie HttpOnly do navegador que iniciou o fluxo.
- **PKCE S256**: `code_verifier` de 86 caracteres, guardado criptografado junto ao state.
- **Tokens**: AES-256-GCM com `TOKEN_ENCRYPTION_KEY`; o contexto (AAD) amarra cada ciphertext à conta e ao tipo de token. Nunca retornados ao frontend.
- **Renovação**: lease no banco (`refresh_lock_id`/`refresh_lock_until`) adquirido por UPDATE condicional — só uma instância chama o ML; as outras aguardam e relêem. Dupla checagem após o lease, gravação do novo par de tokens com *fencing* (só grava quem ainda detém o lease), sem retry automático da renovação (refresh token é de uso único). `invalid_grant` → status `REAUTH_REQUIRED` e tokens apagados.
- **Admin**: senha (hash scrypt), sessão assinada com HMAC, bloqueio de 15 min após 5 falhas por IP; endpoints que alteram estado exigem `Origin` igual a `APP_BASE_URL`.
- **Headers**: HSTS, `X-Frame-Options: DENY`, `nosniff`, `Cache-Control: no-store` nas APIs, `Referrer-Policy: no-referrer` no callback.

## Variáveis de ambiente

Veja [.env.example](.env.example). Além das pedidas, o painel administrativo usa `ADMIN_PASSWORD_HASH` e `SESSION_SECRET`.

```bash
npm run keys:generate   # gera TOKEN_ENCRYPTION_KEY e SESSION_SECRET
npm run admin:hash      # pede a senha e imprime ADMIN_PASSWORD_HASH
```

## Desenvolvimento local

```bash
npm install
cp .env.example .env.local   # preencha; para local: APP_BASE_URL=http://localhost:3000
npm run db:migrate
npm run dev
npm test
```

## Deploy na Vercel

Projeto publicado: `fioetrato-ml` (time leo123-pixels-projects), produção em **https://fioetrato-ml.vercel.app**.
URI de callback: **https://fioetrato-ml.vercel.app/api/auth/mercadolivre/callback**.
`APP_BASE_URL`, `MELI_REDIRECT_URI` e `MELI_PKCE_ENABLED` já estão cadastradas em Production; faltam os segredos (passo 2) e um redeploy.

1. Projeto Vercel com framework Next.js; o `vercel.json` usa `npm run vercel-build` (gera o Prisma Client, aplica `prisma migrate deploy` se `DATABASE_URL` existir, e roda `next build`) e funções em `gru1` (São Paulo).
2. Em *Settings → Environment Variables* (Production), cadastre todas as variáveis do `.env.example`. Use o tipo **Sensitive** para `MELI_CLIENT_SECRET`, `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `SESSION_SECRET` e `ADMIN_PASSWORD_HASH`.
3. `APP_BASE_URL` = domínio de produção atribuído pela Vercel; `MELI_REDIRECT_URI` = `APP_BASE_URL` + `/api/auth/mercadolivre/callback`.
4. Redeploy de produção após salvar as variáveis.

## Cadastro no Mercado Livre Developers

1. https://developers.mercadolivre.com.br/devcenter → *Fio e Trato - MELI* → **Editar**.
2. Em **URIs de redirect**, substitua a URI provisória pela URI de callback de produção (exatamente igual a `MELI_REDIRECT_URI`, sem barra final nem parâmetros).
3. Confira se o **PKCE** está habilitado e mantenha `MELI_PKCE_ENABLED` coerente (`true`/`false`).
4. Salve. Só então inicie o fluxo OAuth.

## Testando a conexão

1. Acesse `https://<dominio>/login` e entre com a senha do administrador.
2. Em **Configurações › Integrações › Mercado Livre**, clique **Conectar Mercado Livre**.
3. Faça login no Mercado Livre com a **conta administradora** do vendedor (operador/colaborador gera `invalid_operator_user_id`) e autorize.
4. De volta ao painel: status **Conectado**, `user_id`, nickname e expiração do token.
5. Clique **Testar conexão (/users/me)** para a chamada autenticada.
