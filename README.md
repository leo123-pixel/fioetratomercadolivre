# Fio & Trato · Integrador ADS ↔ Mercado Livre

- **Fase 1 (concluída):** autenticação OAuth 2.0 (Authorization Code + PKCE S256) com o Mercado Livre (MLB).
- **Fase 2 (esta versão):** catálogo da ADS: importação de produtos, tabelas comerciais, preços e estoque, imagens manuais e rascunhos de anúncio. Veja [Fase 2](#fase-2--catálogo-ads).
- **Fora do escopo por enquanto:** publicação de anúncios, pedidos e sincronização automática com o Mercado Livre. Nenhuma tela publica nada.

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

---

## Fase 2 — Catálogo ADS

### Arquitetura

```
ADS API (somente GET)  ──►  AdsClient (x-api-key + User-Agent, timeout, espaçamento, classificação de erros)
                              │
                     Worker em fatias (lease global no Postgres, cursor por página, backoff)
                              │  UPSERT em lote (jsonb_to_recordset + ON CONFLICT), 1 transação por página
                              ▼
PostgreSQL: products · price_tables · product_prices · product_stocks · ads_suppliers · ads_divisions
            product_images · listing_drafts · import_jobs · import_job_errors · worker_leases · app_settings
                              │
Painel /produtos, /produtos/[id], /importacoes, /configuracoes/tabelas-de-preco      Supabase Storage (imagens)
```

**Fila sem Redis.** O projeto não tinha BullMQ/Redis, então a fila é persistente no próprio PostgreSQL (`import_jobs`):

- `POST /api/import/*` cria a tarefa e responde 202. O processamento roda depois da resposta (`after()`), em fatias de cerca de 45 s. Cada fatia encadeia a próxima chamando `POST /api/import/worker`, autenticada por um token HMAC derivado de `SESSION_SECRET`.
- Um **lease global** (`worker_leases`) garante uma única fatia consultando a ADS por vez. Um índice único parcial impede duas tarefas ativas do mesmo tipo.
- Cada página é gravada **atomicamente junto com o cursor**. Se a função cair (timeout, deploy, restart), o lease expira e a próxima consulta do painel (`GET /api/import/jobs`) retoma do cursor salvo. Há também um Vercel Cron diário de segurança.
- Falhas transitórias (timeout, rede, 429, 5xx, resposta inválida) usam backoff exponencial com até 5 tentativas por página e respeitam `Retry-After`. Depois disso a tarefa é interrompida preservando o que já foi gravado, e o botão **Retomar** continua da página salva. Credencial recusada e erro de configuração encerram sem retentativa.
- Retentativas são idempotentes: UPSERT por chave natural (`ads_product_id`; `ads_product_id + branch_id + price_table_code`; `ads_product_id + branch_id`).

### Decisões de modelagem

| Decisão | Motivo |
|---|---|
| `products.ads_product_id` único | `produtoId` é o identificador de origem; `codFab` **não** é chave. |
| `raw_payload` (JSONB) em produtos, tabelas, preços e estoque | Rastreabilidade do dado original. |
| `name_custom`, imagens e rascunhos fora do UPSERT | Edições manuais nunca são sobrescritas pela importação. |
| `DECIMAL` (14,4 em preços, 14,3 em quantidades) e números convertidos para string antes do SQL | Sem ponto flutuante em valores monetários. |
| Ausência de linha em `product_stocks` = estoque **desconhecido** | Nunca vira zero. `ultVnd` é guardado como `last_sale_at`; `fetched_at` é o horário da consulta do integrador. |
| Preço/estoque de produto ainda não importado vira erro `PRODUCT_NOT_IMPORTED` | Mantém a FK obrigatória para `products` e deixa o problema visível. |
| Tabela de referência em `app_settings`, sem padrão | Não assumimos a tabela `G` (normal). Tabelas inativas não podem ser escolhidas. |
| Preço de referência considera só preços **ativos** | Preços inativos não são sugeridos. `cTeto`, `pvs` e desconto são exibidos sem interpretação. |
| Rascunho: `listing_price`/`listing_quantity` começam vazios | O operador define/confirma; `reference_price` é só um snapshot. |
| Status `READY` exige título ≤ 60, preço, quantidade ≥ 1, imagem e produto ativo | Prepara a regra de publicação futura. |
| Entidades complementares `ads_suppliers`/`ads_divisions` | Nomes nos filtros (sem dados de contato do fornecedor). |
| `unchanged` em `import_jobs` e estado `CANCELED` | Distinguir atualização real de reconsulta; permitir cancelar. |
| Texto + `CHECK` em vez de ENUM | Evolução sem `ALTER TYPE`; CHECKs e índices parciais estão na migration SQL. |

Migration: `prisma/migrations/20261104120000_catalog_phase2/migration.sql`. Só cria tabelas, índices e constraints; não altera nem remove nada da fase 1.

### Endpoints (todos exigem sessão de administrador; os que alteram dados exigem mesma origem)

| Método | Rota | Função |
|---|---|---|
| GET | `/api/products` | Catálogo paginado no servidor: `q`, `supplierId`, `divisionId`, `stock=positive\|zero\|unknown`, `status`, `image`, `draft`, `price`, `sort`, `page`, `pageSize` |
| GET / PATCH | `/api/products/:id` | Detalhe completo / editar `nameCustom` |
| GET | `/api/products/:id/prices` · `/api/products/:id/stock` | Preços por tabela e filial / estoque por filial |
| POST | `/api/products/:id/refresh` | Nova consulta à ADS só deste produto (`scopes`: product, prices, stock) |
| GET / POST / PATCH | `/api/products/:id/images` | Listar / upload multipart (JPEG/PNG ≤ 4 MB, validação pelos bytes) / reordenar e definir principal |
| DELETE | `/api/products/:id/images/:imageId` | Excluir (promove a próxima a principal) |
| POST | `/api/import/products` · `/prices` · `/stocks` · `/price-tables` | Enfileira importação (`{ adsProductIds?: number[] }` para seleção) |
| GET | `/api/import/jobs` · `/api/import/jobs/:id` | Histórico / detalhe com registros de erro |
| POST | `/api/import/jobs/:id/retry` · `/cancel` | Retomar do cursor (ou reprocessar) / cancelar |
| POST | `/api/import/worker` | Interno (token HMAC ou `CRON_SECRET`) |
| GET | `/api/price-tables` | Tabelas comerciais, filiais e configuração |
| GET / PATCH | `/api/settings/default-price-table` | Tabela (e filial) de referência |
| GET / POST | `/api/listing-drafts` | Listar / criar (um produto ou lote; ignora inativos) |
| GET / PATCH | `/api/listing-drafts/:id` | Ler (com verificação de prontidão) / salvar (`status=READY` validado) |

Entradas validadas com Zod. As credenciais da ADS e do Supabase nunca chegam ao navegador nem aos logs.

### Telas

- `/produtos`: indicadores (total, estoque positivo, zerado e desconhecido, sem imagem, com rascunho), botões de importação com progresso ao vivo, pesquisa, filtros, seleção individual e em lote (criar rascunhos, atualizar preço ou estoque dos selecionados) e paginação.
- `/produtos/[id]`: dados de origem com o JSON original, estoque por filial, preços de todas as tabelas, galeria de imagens (upload múltiplo, principal, reordenação, exclusão) e o rascunho do anúncio.
- `/importacoes` e `/importacoes/[id]`: histórico, progresso, contadores, erros, retomar e cancelar.
- `/configuracoes/tabelas-de-preco`: tabelas importadas e escolha da tabela/filial de referência.

### Configuração (Vercel → Production)

| Variável | Tipo | Observação |
|---|---|---|
| `ADS_API_KEY` | Sensitive | Cabeçalho `x-api-key` |
| `ADS_CNPJ` | Plain | CNPJ da distribuidora na rota |
| `ADS_USER_AGENT` | Plain | Mesmo `User-Agent` validado no Postman |
| `ADS_API_BASE_URL` | Plain | Padrão: `https://hom.adsapi.com.br` |
| `SUPABASE_URL` | Plain | `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Sensitive | O bucket público `product-images` é criado no primeiro upload |
| `CRON_SECRET` | Sensitive, opcional | Habilita o cron diário de retomada |

Teste real de leitura na homologação (somente GET, imprime apenas contagens):

```bash
npm run ads:check
```

### Testes

`npm test` roda 109 testes. Os testes de catálogo, importação e imagens usam **PGlite**, um PostgreSQL embarcado que executa as mesmas migrations de produção; assim UPSERT, ON CONFLICT, FKs, CHECKs e índices parciais são testados em Postgres real. A ADS, o Supabase Storage e o Mercado Livre são simulados.

### Pendências e próxima etapa

- Confirmar com a ADS: `ids` aparece como obrigatório no OpenAPI, mas a listagem completa foi validada sem ele no Postman; semântica de `cTeto`, `pvs`, `desconto` e do saldo de estoque; limite máximo de `pageSize`; política de rate limit.
- Atualização incremental pelo parâmetro `alterado` da ADS, para reduzir as cerca de 260 requisições de uma carga completa (3.089 produtos + 10.077 preços em páginas de 50).
- Próxima fase (publicação manual no Mercado Livre): preditor de categoria (`/sites/MLB/domain_discovery/search`), atributos obrigatórios por categoria (`/categories/{id}/attributes`), upload das imagens a partir da `public_url`, `POST /items` usando o `getValidAccessToken()` da fase 1, gravação do `item_id` no rascunho e sincronização de preço e estoque.
