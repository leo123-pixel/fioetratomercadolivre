# Fase 1 — Nuvemshop (somente leitura)

Conexão OAuth, importação do catálogo, variantes, estoque por localização, vinculação com a ADS e leitura pelo
Inventory Core. **Nada é escrito na Nuvemshop**: nenhum produto, preço ou estoque é criado ou alterado, e
nenhum pedido vai para a ADS. O Inventory Core continua em modo sombra, e o sincronizador do Mercado Livre não
foi alterado.

---

## 1. Auditoria do projeto

| Funcionalidade | Estado atual | Reutilização | Ajuste necessário | Risco |
|---|---|---|---|---|
| Next.js 15 (App Router), TypeScript, rotas `src/app/api` | Em produção | Mesmo padrão de rotas e `adminHandler` | Rotas novas em `/api/nuvemshop/*` e `/api/auth/nuvemshop/*` | Baixo |
| Banco | PostgreSQL (Supabase) com SQL parametrizado (`Sql`), migrations SQL do Prisma | `getSql()`, transações e o padrão das migrations | Migration nova só com tabelas `nuvemshop_*` | Baixo (não altera tabelas existentes) |
| Autenticação administrativa | Sessão por cookie, `requireAdminPage`, `adminHandler` (sessão, mesma origem, limite por minuto) | Integral | Nenhum | — |
| Criptografia | AES-256-GCM com AAD (`encryptSecret`) | Integral; AAD `nuvemshop:access_token:<app>:<loja>` | Nenhum | — |
| OAuth do ML | State de uso único, guardado só como hash e amarrado ao navegador por cookie | Mesmo desenho | Tabela própria de states, para um callback nunca consumir o state do outro provedor | — |
| Catálogo ADS (`products`) | Identidade central `ADS-<id>` | É o alvo dos vínculos | Nenhum | — |
| Vínculos ML (`marketplace_product_mappings`) | Exclusivos do ML: índices únicos por anúncio, sem coluna de canal | Usados como evidência (SKU validado em pedidos ML) | Tabela própria `nuvemshop_variant_mappings`: alterar os índices do ML colocaria a produção em risco | Médio, se reaproveitada → evitado |
| Motor de correspondência ML (`stock/matching.ts`) | SKU, GTIN e código do fabricante; nunca título | `isValidGtin` e as mesmas regras | SQL de candidatos para variantes | — |
| Filas e jobs | `import_jobs`, lease em `worker_leases`, fatias serverless de 45 s encadeadas | `acquireLease`, `runSliceAndChain` e a rota `/api/import/worker` | Fila própria `nuvemshop_catalog_import_jobs` dentro da mesma fatia | Baixo |
| Logs | `logger` com sanitização de tokens | Integral | Nenhum | — |
| Inventory Core | Fase 0 implantada; `InventoryChannelAdapter`; Nuvemshop simulada | Contrato do adaptador, pools e `planQuotas` | Adaptador real de leitura; a reconciliação lê a quantidade observada | Baixo (só no modo sombra) |
| Preview na Vercel | `DATABASE_URL` de Preview aponta para o banco de produção | — | Ver Pendências | **Alto:** migrations de branch rodam na produção |

**Inventory Core confirmado em funcionamento** (não só pela existência das classes): `runShadowReconciliation`
roda em produção; a primeira reconciliação ficou COMPLETED com 266 pools. O teste "cota simulada" desta fase
roda a reconciliação real com a Nuvemshop conectada.

## 2. Confirmação da arquitetura do Inventory Core

- O contrato `InventoryChannelAdapter` foi mantido. Nenhuma segunda interface foi criada.
- `NuvemshopInventoryAdapter` implementa getChannelInventory, getProductMappings e validateInventoryCapability,
  e acrescenta getLocations e getInventorySnapshot.
- `applyStockUpdate` passa pelo portão `assertRemoteWriteAllowed`, que sempre recusa.
- O cálculo de cotas não mudou. A única mudança na reconciliação: com loja conectada, a quantidade observada
  na Nuvemshop entra como exposição atual do canal (reachable=false, simulated=true).
  - Consequência correta: o ML não ganha aumento usando unidades que já estão expostas na Nuvemshop.
  - A divergência OVER_EXPOSED passa a somar os dois canais.
  - Nova divergência NS_EXPOSURE_UNKNOWN: quantidade desconhecida, que nunca vira zero.

## 3. Serviços existentes reutilizados

`adminHandler`, `requireAdminPage`, `encryptSecret/decryptSecret`, `randomToken/sha256Hex`, `logger/redactString`,
`getSql`, `acquireLease/renewLease/releaseLease`, `runSliceAndChain/scheduleWorker`, `isValidGtin`,
`ProductPicker` (busca de produto ADS), `getInventorySettings`, `planQuotas` e `runShadowReconciliation`.

## 4. Serviços novos (`src/lib/nuvemshop/`)

| Arquivo | Papel |
|---|---|
| `env.ts` | Configuração (`NUVEMSHOP_*`), validação do callback e hosts oficiais |
| `read-only.ts` | Política da Fase 1: `assertNuvemshopWriteAllowed` sempre lança |
| `client.ts` | **NuvemshopApiClient**: só GET, paginação, limite (leaky bucket), backoff, timeouts e erros tipados |
| `oauth.ts` | **NuvemshopOAuthService**: início, callback, troca do code, verificação em GET /store, escopos |
| `store.ts` | Cadastro da loja, token cifrado, reinstalação, desconexão, cliente da loja conectada |
| `connection.ts` | Verificação real da conexão (GET /store e GET /locations) e capacidades observadas |
| `catalog.ts` | Conversão e gravação de produtos, variantes, imagens, categorias, localizações e níveis de estoque |
| `import.ts` | Fila de importação (FULL/INCREMENTAL), fases, cursor, tentativas e lease |
| `mapping.ts` | **NuvemshopProductMappingService**: sugestões, confirmação, rejeição, correção, revogação, lote seguro, histórico |
| `queries.ts` | Listagens, painel e simulação (dados locais) |
| `webhooks.ts` | Webhooks obrigatórios de privacidade (HMAC) |
| `src/lib/inventory/adapters/nuvemshop.ts` | **NuvemshopInventoryAdapter** (leitura); o adaptador simulado continua |

## 5. Arquivos criados

- Migration: `prisma/migrations/20261117000000_nuvemshop_phase1/migration.sql`
- Bibliotecas: os 11 arquivos de `src/lib/nuvemshop/`
- Rotas:
  - `src/app/api/auth/nuvemshop/{route,callback/route}.ts`
  - `src/app/api/nuvemshop/{_shared,connection,disconnect,import,import/[id],import/[id]/cancel,products,products/[variantId],mappings,locations,simulation}`
  - `src/app/api/webhooks/nuvemshop/[topic]/route.ts`
- Telas:
  - `src/app/(admin)/nuvemshop/{page,NuvemshopDashboard,NuvemshopTabs}.tsx`
  - `src/app/(admin)/nuvemshop/produtos/{page,VariantDetail}.tsx`
  - `src/app/(admin)/nuvemshop/produtos/vinculacao/{page,MappingPanel}.tsx`
  - `src/app/(admin)/nuvemshop/simulacao/page.tsx`
- Testes: `tests/nuvemshop.test.ts` e `tests/helpers/nuvemshop-mock.ts`

## 6. Arquivos modificados

| Arquivo | Mudança |
|---|---|
| `src/lib/inventory/adapters/nuvemshop.ts` | Adaptador de leitura (o simulado mantido) |
| `src/lib/inventory/shadow.ts` | Lê a exposição Nuvemshop na reconciliação sombra |
| `src/lib/inventory/queries.ts` | Coluna `nsObserved` nas posições |
| `src/lib/imports/scheduler.ts` | Fila Nuvemshop na mesma fatia do worker |
| `src/lib/api.ts` | Mapeamento dos erros Nuvemshop para JSON |
| `src/app/(admin)/layout.tsx` | Item de menu "Nuvemshop" |
| `src/app/(admin)/estoque/controle-central/page.tsx` | Coluna "Lido na Nuvemshop" |
| `tests/helpers/pg.ts` | Limpeza das tabelas novas |
| `.env.example`, `README.md` | Variáveis e link para esta documentação |

## 7. Migração

`20261117000000_nuvemshop_phase1` só cria tabelas, sem alterar nenhuma tabela existente:

- `nuvemshop_stores`
- `nuvemshop_oauth_states`
- `nuvemshop_products`
- `nuvemshop_variants`
- `nuvemshop_product_images`
- `nuvemshop_categories`
- `nuvemshop_locations`
- `nuvemshop_inventory_levels`
- `nuvemshop_catalog_import_jobs`
- `nuvemshop_catalog_import_attempts`
- `nuvemshop_variant_mappings`
- `nuvemshop_mapping_components`
- `nuvemshop_mapping_history` (somente inserção, por trigger)

Todas as chaves de catálogo levam `store_id`. Garantias no próprio banco:

- uma loja conectada por vez;
- uma importação ativa por loja;
- um vínculo vigente por variante;
- uma sugestão aberta por variante × produto;
- CHECKs de situação.

## 8. Endpoints

Todos exigem administrador. Os que gravam exigem a mesma origem e têm limite por minuto.

| Método e rota | Função |
|---|---|
| `GET /api/auth/nuvemshop` | Inicia a instalação/autorização |
| `GET /api/auth/nuvemshop/callback` | Retorno OAuth |
| `GET /api/nuvemshop/connection` | Situação da conexão (sem token) |
| `POST /api/nuvemshop/connection` | Verificação real da conexão |
| `POST /api/nuvemshop/disconnect` | Desconexão administrativa |
| `GET /api/nuvemshop/import` | Histórico e retomada do worker |
| `POST /api/nuvemshop/import` | Enfileira `{mode: FULL\|INCREMENTAL}` |
| `GET /api/nuvemshop/import/:id` | Progresso e tentativas |
| `POST /api/nuvemshop/import/:id/cancel` | Cancela a importação |
| `GET /api/nuvemshop/products?filter&q&page` | Lista de variantes |
| `GET /api/nuvemshop/products/:variantId` | Detalhe, estoque por localização, candidatos e histórico |
| `POST /api/nuvemshop/mappings` | `confirm`, `reject`, `revoke`, `bulk_confirm_safe`, `refresh_suggestions` |
| `GET /api/nuvemshop/locations` | Localizações lidas da loja |
| `PUT /api/nuvemshop/locations` | Localização ↔ depósito do Inventory Core |
| `GET /api/nuvemshop/simulation` | Cotas simuladas × observado |
| `POST /api/webhooks/nuvemshop/{store-redact,customers-redact,customers-data-request}` | Privacidade, com HMAC e sem sessão |

## 9. Telas administrativas

- **`/nuvemshop`**
  - conexão: status, loja, Store ID, plano, localizações e escopos;
  - ações: conectar, verificar, desconectar;
  - indicadores: produtos, variantes, vinculados, não vinculados, ambíguos, sem SKU, a revisar, estoque divergente;
  - importação: última, falhas, importar e atualizar catálogo, progresso e cancelamento;
  - mapeamento localização ↔ depósito;
  - situação da leitura pelo Inventory Core.
- **`/nuvemshop/produtos`**: imagem, nome, SKU, Product ID, Variant ID, preço, estoque, publicação, vínculo ADS
  e atualização; busca, filtros, paginação e detalhe.
- **`/nuvemshop/produtos/vinculacao`**:
  - 12 filtros: todos, vinculados, não vinculados, sugestão pendente, ambíguo, a revisar, SKU duplicado,
    sem SKU, sem GTIN, divergência de estoque, sem estoque conhecido e removidos;
  - por linha: buscar produto ADS, confirmar, rejeitar, revisar, desvincular com motivo, composição de kit e histórico;
  - lote seguro.
- **`/nuvemshop/simulacao`**: saldo ADS, reserva, compromissos não refletidos, saldo vendável, cota ML e cota
  Nuvemshop (ambas **simuladas**) e o observado real em cada canal.
- **`/estoque/controle-central`**: coluna nova "Lido na Nuvemshop (real)".

Não existe botão de sincronização de estoque.

## 10. Configurações OAuth

- Fluxo: somente authorization code.
- Autorização: `https://www.nuvemshop.com.br/apps/{NUVEMSHOP_APP_ID}/authorize?state=…`
- Troca do code: `POST https://www.nuvemshop.com.br/apps/authorize/token`, com JSON
  `{client_id, client_secret, grant_type: "authorization_code", code}` (o code expira em 5 min).
  - O domínio `nuvemshop.com.br` equivale a `tiendanube.com`, segundo a documentação.
  - O endereço `www.nuvemshop.com/...` citado na especificação não é o documentado; usamos o oficial.
- Resposta: `{access_token, token_type, scope, user_id}`, em que `user_id` é o ID da loja.
- Ciclo do token: não expira e não tem refresh token. Ele é invalidado por um novo token do mesmo app × loja ou
  pela desinstalação do aplicativo. Nesse caso a API responde 401, a loja fica como "Reautorização necessária"
  e um "Reconectar" substitui o token.
- API: `https://api.tiendanube.com/2025-03/{store_id}` com `Authorization: Bearer <token>` e `User-Agent`
  obrigatório. A especificação citava o cabeçalho `Authentication`; a documentação vigente usa
  `Authorization: Bearer`.
- CSRF: state aleatório, de uso único, válido por 10 min, guardado como hash e amarrado ao navegador por cookie
  HttpOnly. Retorno sem state é recusado: a conexão deve partir do botão "Conectar loja".

## 11. Permissões necessárias

| Escopo | Uso | Fase |
|---|---|---|
| `read_products` | Produtos, variantes, imagens e categorias | **Agora (obrigatório)** |
| `read_locations` | Localizações | Agora (concedido automaticamente a quem tem `read_products`) |
| `write_products` | Edição de produtos, estoque e preço | Futuro |
| `read_orders` | Leitura de pedidos (inclui `read_fulfillment_orders`) | Futuro |
| `read_customers` | Leitura de clientes | Futuro |

- Os escopos são definidos no aplicativo (Portal de Parceiros), não na URL.
- Acrescentar um escopo exige reinstalar o aplicativo na loja, o que gera um novo token.
- Recomendação: pedir agora só `read_products` e acrescentar os demais na fase em que forem usados.
- Mesmo com escopo de escrita, o backend recusa qualquer escrita nesta fase.

## 12. Procedimento de instalação do aplicativo

1. No [Portal de Parceiros](https://partners.nuvemshop.com.br), crie um aplicativo para a própria loja.
2. Configure as URLs do aplicativo:
   - **URL de redirecionamento:** `https://fioetrato-ml.vercel.app/api/auth/nuvemshop/callback`
     - não use a URL padrão do Portal, que leva ao login de parceiro;
   - **URL do app** e **URL de preferências:** `https://fioetrato-ml.vercel.app/nuvemshop`
   - **URL de política de privacidade:** `https://fioetrato-ml.vercel.app/politica-de-privacidade`
   - **Store redact:** `https://fioetrato-ml.vercel.app/api/webhooks/nuvemshop/store-redact`
   - **Customers redact:** `https://fioetrato-ml.vercel.app/api/webhooks/nuvemshop/customers-redact`
   - **Customers data request:** `https://fioetrato-ml.vercel.app/api/webhooks/nuvemshop/customers-data-request`
3. Escopo: `read_products`.
4. Na Vercel (Production), configure:
   - `NUVEMSHOP_APP_ID` (ID do aplicativo);
   - `NUVEMSHOP_CLIENT_SECRET` (como sensível);
   - `NUVEMSHOP_REDIRECT_URI` (o mesmo endereço do item 2);
   - `NUVEMSHOP_PHASE1_READ_ONLY=true`.
5. Faça novo deploy, entre no painel do integrador e use **Nuvemshop › Conectar loja**. Aceite as permissões na
   Nuvemshop; o retorno grava a loja depois de confirmar em GET /store.
6. Clique em **Verificar conexão**, que faz uma consulta real à API.
7. Em **Localizações**, associe a localização ao depósito `principal`.
8. Clique em **Importar catálogo**.
9. Vincule as variantes em **Vinculação ADS**.
10. Rode a reconciliação do Estoque central.

## 13. URL de callback

`https://fioetrato-ml.vercel.app/api/auth/nuvemshop/callback`

Precisa ser idêntica em `NUVEMSHOP_REDIRECT_URI` e no aplicativo; o servidor valida isso na inicialização.

## 14 a 18. Conexão, importação, variantes, vínculos e localizações

**Ainda não executados contra a loja real.** Dependem do aplicativo e das credenciais (item 12). Por isso não
afirmamos que a conexão funciona: isso só vale depois de "Verificar conexão" responder com a loja real.

Com a API simulada nos testes, ficou demonstrado:

- conexão, verificação e reinstalação;
- importação completa (55 produtos em 2 páginas) e incremental (`updated_at_min`);
- variantes virtuais e múltiplas, variantes buscadas em `/products/{id}/variants`, removidas e recriadas;
- sugestões por SKU ADS, GTIN e vínculo existente; ambiguidades; kits;
- estoque em uma e em várias localizações.

## 19. Integração em leitura com o Inventory Core

O teste "cota simulada" roda a reconciliação sombra real:

- ADS 10 e reserva 2 resultam em saldo vendável 8;
- política 50/50: ML 4 e Nuvemshop 4 (SIMULATED);
- quantidade Nuvemshop observada: 4;
- **0 escritas remotas e 0 chamadas de rede** durante a reconciliação (ela só lê o banco).

## 20. Simulações de cota

- `/nuvemshop/simulacao` mostra os valores da última reconciliação, marcados como simulados.
- A divisão de referência (10 / 2, com ML 4 e Nuvemshop 4) é configurada na política do Estoque central.
- Para testar outras divisões sem gravar nada, use o Simulador de cotas.
- A cota simulada nunca é apresentada como quantidade aplicada.
- O anunciado no ML não é usado como prova de que a cota nova foi confirmada.

## 21. Testes realizados

- `tests/nuvemshop.test.ts`: **21 testes**, todos passando.
  - **OAuth:** autorização; state inválido, ausente, reutilizado e de outro navegador; code inválido; token
    inválido; reinstalação; loja incorreta; outra loja conectada; escopo insuficiente; revogação (401);
    desconexão.
  - **Catálogo:** paginação; importação completa e incremental; reimportação sem duplicar; variante virtual;
    várias variantes; variantes fora do payload; SKU ausente e duplicado; GTIN inválido; imagem inexistente;
    produto removido; variante removida e recriada.
  - **Vinculação:** SKU único; GTIN único; ambíguo; produto não encontrado; manual; correção; rejeição;
    revogação com motivo; lote seguro; kit; histórico imutável.
  - **Estoque:** uma e várias localizações; zero; ilimitado; desconhecido; localização não mapeada e excluída;
    cota simulada; reserva de segurança; nenhuma escrita remota.
  - **Infraestrutura:** 429, 5xx, timeout e falha de rede com retentativa limitada; 401/403 sem repetir;
    falha transitória na fila; worker reiniciado retoma do cursor; falha definitiva (FAILED); uma importação
    ativa por loja; um worker por vez.
  - **Somente leitura:** o portão recusa sempre, mesmo com `NUVEMSHOP_PHASE1_READ_ONLY=false`; varredura
    estática (nenhum POST/PUT/PATCH/DELETE na API da Nuvemshop); webhooks com HMAC; rotas com administrador e
    mesma origem; a conexão não expõe o token.
- **Regressão:** suíte completa com **401/401** (os 380 testes anteriores continuam passando). Ela cobre login
  administrativo, OAuth ML, anúncios, sincronização ML, pedidos ML, ADS, Inventory Core e site institucional.
- `tsc --noEmit` sem erros e `next build` sem erros.
- No Windows, rode `npx vitest run --maxWorkers=2`: o paralelismo padrão estoura a memória com o PGlite.

## 22. Pendências

1. **Credenciais e aplicativo** (item 12), sem os quais os itens 14 a 18 não podem ser validados na loja real.
2. **DATABASE_URL de Preview na Vercel aponta para a produção**: o deploy de preview desta branch aplicaria a
   migration na produção antes do merge. Esta migration só cria tabelas, mas o ideal é separar o banco de
   preview antes do push.
3. **Telas não verificadas no navegador:** elas compilam (`next build`), mas não foram abertas, porque falta um
   banco local; verificar depois do deploy.
4. A importação roda sob demanda: não há agendamento periódico nem webhooks `product/*`. Isso fica para a fase
   de sincronização.
5. Associação localização ↔ depósito: com uma única filial ADS e um depósito, basta mapear a localização padrão.
6. Pendências herdadas da fase 0: confirmar com a Tecdisa quando a ADS baixa o saldo.

## 23. Variáveis de ambiente

| Variável | Valor |
|---|---|
| `NUVEMSHOP_APP_ID` | ID do aplicativo |
| `NUVEMSHOP_CLIENT_SECRET` | Segredo do aplicativo (sensível) |
| `NUVEMSHOP_REDIRECT_URI` | `https://fioetrato-ml.vercel.app/api/auth/nuvemshop/callback` |
| `NUVEMSHOP_PHASE1_READ_ONLY` | `true` |
| `NUVEMSHOP_USER_AGENT` | Opcional |
| `NUVEMSHOP_API_BASE_URL` | Opcional |
| `NUVEMSHOP_AUTH_BASE_URL` | Opcional |

## 24. Status do deploy

Ainda não publicado. O código está na branch `nuvemshop-fase1`; o deploy aguarda a decisão sobre o banco de
preview (pendência 2) e as variáveis do item 23. A escrita remota está desativada no código, sem depender de
variável.

## 25. Próxima fase recomendada

**Fase 2: estoque Nuvemshop em piloto controlado.**

1. Acrescentar `write_products` e reinstalar o aplicativo.
2. Escolher poucos SKUs com estoque alto e política explícita.
3. Liberar o portão **só** para a Nuvemshop e só via outbox.
4. Usar o estoque por localização (PUT de inventory levels, nunca o `variant.stock` legado).
5. Confirmar com `verifyStockUpdate` por leitura antes de marcar a cota como confirmada.
6. Transferências entre ML e Nuvemshop pelo protocolo seguro.

Depois disso, na Fase 3, vêm a leitura de pedidos Nuvemshop (`read_orders`) com reservas no Inventory Core e o
envio à ADS.
