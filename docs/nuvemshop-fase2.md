# Fase 2 — Nuvemshop: produtos, imagens, preço e estoque automáticos

Produtos, variantes e imagens editáveis pelo painel; sincronização automática de **preço** (tabela ADS → Nuvemshop) e
de **estoque** (cota do Inventory Core → Nuvemshop); proteção de pedidos pendentes; webhooks persistentes; fila de
escritas com confirmação por leitura; modos SHADOW/PILOT/AUTOMATIC/PAUSED e desligamento de emergência.

**Implementação e ativação são marcos separados.** O deploy desta fase não liga nada: as duas automações nascem
`DISABLED` e toda escrita depende de `NUVEMSHOP_WRITE_ENABLED=true`. Nenhuma escrita real foi feita numa loja; a
sincronização produtiva **não está homologada** (ver §15 e §17).

---

## 1. Auditoria do sistema

| Componente | Situação encontrada | Uso nesta fase |
|---|---|---|
| Nuvemshop Fase 1 (`src/lib/nuvemshop/*`) | OAuth, cliente só GET, importação, vínculos variante ↔ ADS, adaptador de leitura no Inventory Core | Reaproveitado; o cliente ganhou `send()` com permissão do portão |
| Portão da Fase 1 (`read-only.ts`) | Recusava sempre | **Substituído** por `write-gate.ts` (escrita condicionada) |
| Inventory Core (`src/lib/inventory/*`) | Modo sombra; `planQuotas`, cotas exclusivas, compromissos, `recordOrderEvents`, reconciliação | **Único motor de estoque.** A Nuvemshop vira canal real quando a automação sai de DISABLED |
| Sincronizador de estoque ML (`src/lib/stock/reconcile.ts`) | Em produção, automação ligada (escopo ALL_LINKED) | **Não alterado.** Tratado como escritor concorrente (§7) |
| Preço ML (`src/lib/stock/prices.ts`) | Em produção | Reaproveitado `fetchAdsPrices`/`pickPrice` (leitura da tabela ADS) |
| Agendador (`src/lib/marketplace/scheduler.ts`) | pg_cron a cada 5 min → tick de 240 s | Ganhou o ciclo Nuvemshop no fim do tick, com 60 s reservados |
| Filas/leases (`worker_leases`, `FOR UPDATE SKIP LOCKED`) | Em uso | Reaproveitados (leases próprios) |
| Alertas (`raiseAlert`), logs, auditoria (`inventory_audit_logs`) | Em uso | Reaproveitados |
| Webhooks Nuvemshop | Só os de privacidade | Novo endpoint `/api/webhooks/nuvemshop/events` |

Não foram duplicados: motor de cotas, posição segura, compromissos, cliente HTTP, OAuth, mapeamento.

## 2. Serviços implementados (`src/lib/nuvemshop/`)

| Arquivo | Serviço |
|---|---|
| `write-gate.ts` | Portão único de escrita: ambiente, escopo `write_products`, desligamento de emergência; `WritePermit` exigida pelo cliente |
| `client.ts` | `send()`: escrita com retentativa só em 429 (e 5xx/timeout quando idempotente); resultado incerto sinalizado |
| `automation.ts` | Modos, aprovação do automático, pausa/reativação, emergência, participação por variante, políticas |
| `remote-state.ts` | Releitura de produtos por ids (antes e depois de cada escrita), sem interferir na importação |
| `write-jobs.ts` | Fila persistente de escritas, worker em lote, compare-and-set, verificação, incertos, reconciliação |
| `price-sync.ts` | **NuvemshopAutomaticPriceSyncService** |
| `stock-sync.ts` | **NuvemshopAutomaticStockSyncService** |
| `orders.ts` | Proteção de pedidos pendentes (compromissos no Inventory Core) e reconciliação de pedidos |
| `events.ts` | Webhooks: persistência, processamento, prevenção de loop, cadastro na loja |
| `products-admin.ts` | Criar/editar produto, variantes, imagens, publicação manual, reconciliação de criação incerta |
| `scheduler.ts` | Ciclo Nuvemshop dentro do tick |
| `automation-queries.ts` | Dados do painel |

## 3. Arquivos modificados

| Arquivo | Mudança |
|---|---|
| `src/lib/nuvemshop/client.ts` | `send()` e `uncertain`/`body` no erro |
| `src/lib/nuvemshop/read-only.ts` | Removido (substituído por `write-gate.ts`) |
| `src/lib/nuvemshop/connection.ts` | Estado da escrita e escopos da Fase 2 no painel |
| `src/lib/nuvemshop/catalog.ts` | `upsertProduct` aceita `jobId` nulo (releitura fora da importação) |
| `src/lib/inventory/shadow.ts` | Nuvemshop deixa de ser simulada com a automação ligada; propostas por variante `channel = nuvemshop` |
| `src/lib/inventory/adapters/nuvemshop.ts` | Capacidade `writableByApi` (a escrita continua fora do núcleo) |
| `src/lib/marketplace/scheduler.ts` | Ciclo Nuvemshop no fim do tick; ML usa o prazo menos 60 s quando há loja conectada |
| `src/lib/api.ts` | `AutomationError` → JSON |
| Telas | `NuvemshopTabs` (aba Automações, aviso da Fase 2), `NuvemshopDashboard`, `produtos/page.tsx` (link editar/criar) |
| Testes | `tests/nuvemshop.test.ts` (portão novo), `tests/inventory-core.test.ts` (varredura: núcleo não chama escrita Nuvemshop), `tests/helpers/pg.ts`, `tests/helpers/nuvemshop-mock.ts` |
| `.env.example`, `README.md` | `NUVEMSHOP_WRITE_ENABLED` e link para este documento |

Novos: os 11 serviços acima, 8 rotas de API, 3 telas (`/nuvemshop/automacoes`, `/nuvemshop/catalogo/[productId]`,
`/nuvemshop/catalogo/novo`), migration e `tests/nuvemshop-phase2.test.ts`.

## 4. Migração

`prisma/migrations/20261119000000_nuvemshop_phase2/migration.sql` — **só cria tabelas**:

| Tabela | Função / garantias |
|---|---|
| `nuvemshop_automation_settings` | Modo, escopo, intervalo, política (PRICE/STOCK). Começa DISABLED. `CHECK`: AUTOMATIC exige aprovação registrada |
| `nuvemshop_emergency_stop` | Linha única do desligamento de emergência |
| `nuvemshop_sync_variants` | Participação (NONE/PILOT/INCLUDED/EXCLUDED) e último estado por variante × tipo (decisão, alvo, escrito, origem, “sujo”) |
| `nuvemshop_sync_runs` / `nuvemshop_sync_items` | Execuções e decisão por variante (histórico) |
| `nuvemshop_write_jobs` | Fila de escritas. **Índice único parcial em `lock_key`** (tipo:loja:variante:localização) para PENDING/RUNNING/UNCERTAIN/REQUIRES_RECONCILIATION; chave idempotente única |
| `nuvemshop_write_attempts` | Cada tentativa: lote, HTTP, antes/depois, duração |
| `nuvemshop_product_operations` | Auditoria de catálogo; **uma criação em andamento/incerta por produto ADS** (índice único) |
| `nuvemshop_webhook_events` | Eventos persistidos antes do processamento; dedup único |
| `nuvemshop_webhook_registrations` | Webhooks cadastrados na loja |
| `nuvemshop_orders` | Pedidos para proteção de estoque — **sem dados pessoais** |

Atenção (herdado da Fase 1): o Preview da Vercel aponta para o banco de produção; esta migration só cria tabelas.

## 5. Endpoints

Administrativos (sessão; os que gravam exigem mesma origem e têm limite por minuto):

| Método e rota | Função |
|---|---|
| `GET /api/nuvemshop/automation` | Painel completo |
| `POST /api/nuvemshop/automation` | `set_mode`, `pause`, `resume`, `simulate`, `settings`, `participation`, `approve_price`, `resolve_job`, `reconcile` (orders/catalog/uncertain/writer), `register_webhooks`, `confirm_ads`, `emergency_stop`, `release_emergency` |
| `GET /api/nuvemshop/automation/runs/:id` | Execução e decisões |
| `GET /api/nuvemshop/automation/jobs/:id` | Tentativas de uma escrita |
| `GET /api/nuvemshop/automation/variants?kind&q&participation&page` | Seleção de SKUs |
| `GET /api/nuvemshop/orders?state` | Pedidos da proteção |
| `GET/POST /api/nuvemshop/catalog` | Criações incertas / criar produto a partir da ADS |
| `GET/POST /api/nuvemshop/catalog/:productId` | Editor: `update`, `visibility`, `create_variant`, `update_variant`, `add_image`, `set_main_image`, `remove_image`, `reconcile_create` |

Público: `POST /api/webhooks/nuvemshop/events` (HMAC `x-linkedstore-hmac-sha256`).

API Nuvemshop usada (2025-03): `GET/POST /products`, `GET/PUT /products/{id}`, `POST/PUT /products/{id}/variants[/{id}]`,
`POST/PUT/DELETE /products/{id}/images[/{id}]`, `PATCH /products/stock-price`, `GET /orders`, `GET /orders/{id}`,
`GET/POST /webhooks`. **Nunca** `PUT /products/{id}/variants` (coleção: apaga variantes omitidas e troca IDs) nem o
campo legado `stock` para escrita.

## 6. Regras de preço

1. Tabela comercial ADS **F** (FIO & TRATO) por padrão — **diferente da tabela M usada no Mercado Livre**. As duas configurações são independentes (Nuvemshop em `nuvemshop_automation_settings.policy`, ML em `app_settings.price_sync_settings`); o cache `product_prices` guarda cada tabela separada (produto × filial × tabela). Filial opcional.
   - **Origem do preço:** no horário da ADS, leitura ao vivo (GET). Fora do horário (ou com a ADS fora do ar) usa o preço da tabela **já gravado no sistema** (`product_prices`), desde que lido há no máximo `cacheMaxAgeHours` (padrão 48 h, configurável no card Preço); mais antigo fica bloqueado (`ADS_PRICE_STALE`) e nunca é aplicado. Cada decisão registra a origem (ADS ao vivo ou banco, com a data da leitura).
2. Só vínculos CONFIRMED de produto simples; kits bloqueados.
3. Preço alvo = tabela × (1 + margem) → arredondamento (nenhum, ,90, ,99, inteiro acima) → mínimo.
4. **Descontos da ADS não são aplicados** (só o preço da tabela; a semântica do desconto não foi validada).
5. Preço ADS ausente, zero ou erro → bloqueado (nunca escreve zero). Tabela sem nenhum preço → alerta.
6. Promoção: `BLOCK` (padrão) não mexe em variante com `promotional_price`; `KEEP` atualiza o preço cheio só se a promoção continuar menor.
7. Variação acima de `maxChangePct` (padrão 20%) ou variante sem preço → **revisão**; aprovação cria escrita MANUAL.
8. Escrita: `PATCH /products/stock-price` só com `price`, em lotes de até 50; releitura confirma o valor.
9. Frequência configurável (padrão 30 min); inclusão/exclusão por variante.

## 7. Regras de estoque e transferência entre canais

- O conector **não calcula cota**: lê a proposta por variante que o Inventory Core grava na reconciliação.
- Fluxo por execução: releitura das variantes → reconciliação do núcleo só desses produtos (saldo ADS ao vivo no horário;
  fora dele o cache envelhece e só permite reduzir) → proposta por variante → travas do canal → fila.
- Travas (reduções sempre permitidas; aumentos bloqueados se qualquer uma valer):
  - proteção de pedidos não operante;
  - venda Nuvemshop sem baixa ADS confirmada além do prazo (padrão 48 h) ou em reconciliação;
  - pedido recente com variante sem vínculo no mesmo produto;
  - **produto cujo estoque no ML é escrito pelo sincronizador atual** (automação ligada para ele ou ajuste manual em andamento);
  - dados do núcleo sem confiabilidade (saldo velho, compromissos em reconciliação).
- Bloqueios absolutos: quantidade remota desconhecida, estoque não controlado (ilimitado), localização não associada
  ou mais de uma localização no mesmo depósito, política com cota ZERO para a Nuvemshop, cota desconhecida.
- Escrita só na localização associada ao depósito do canal (`location_id` quando a loja tem várias localizações).

**Transferência ML ↔ Nuvemshop:** não há transferência real nesta fase. Enquanto o ML é escrito pelo sincronizador
atual, uma cota do ML no núcleo é só simulada e não é tratada como aplicada. A proteção vem de dois pontos:
`planQuotas` dá à Nuvemshop apenas a folga **não exposta** no ML (o anunciado no ML continua exposto até ser
reduzido), e a trava de escritor concorrente impede aumento na Nuvemshop em produtos que o ML pode aumentar sozinho.

**Plano de transferência de responsabilidade** (para habilitar redistribuição real):
1. Piloto Nuvemshop com SKUs **sem** anúncio ativo no ML (não há concorrente).
2. Para um SKU vendido nos dois canais: mudar a automação do ML para `APPROVED_GROUPS` e desaprovar o grupo do produto
   (recurso existente) — o ML deixa de aumentar sozinho; a trava libera a Nuvemshop.
3. Comparar por algumas semanas as propostas do núcleo para o ML com os jobs do sincronizador atual (Fase 0, §19).
4. Fazer o sincronizador do ML descontar a exposição Nuvemshop confirmada, ou migrá-lo para o adaptador do núcleo, com
   flag explícita — só então o protocolo de transferência (reduzir origem → confirmar → aumentar destino) é ativado
   com executor real. Até lá, `inventory_quota_transfers` continua só simulada (`CHECK (simulated)`).

## 8. Integração com o Inventory Core

- `shadow.ts`: com a automação de estoque Nuvemshop ≠ DISABLED, o canal passa a `simulated=false` (alocação gravada como
  real), `reachable` em PILOT/AUTOMATIC; a cota é distribuída por variante com `distributeWithinChannel` (vários
  anúncios do mesmo SKU não multiplicam cota; kits pela composição) e gravada em `inventory_sync_proposals`
  (`channel = nuvemshop`). Com a automação desligada, o comportamento é idêntico à Fase 1 (testado).
- O núcleo continua sem escrita remota: `assertRemoteWriteAllowed` inalterado; a varredura estática agora também
  proíbe `enqueueWrite`, `processWriteJobs`, `issueWritePermit` e `.send(` dentro de `src/lib/inventory`.
- Pedidos Nuvemshop entram por `recordOrderEvents(channel: "nuvemshop")`.

## 9. Controle de cotas

Herdado do núcleo e verificado pelos testes de propriedade da Fase 0 (5.000 combinações): percentual, fixa, máximo,
mínimo, prioridade, reserva de segurança, sobra por prioridade, soma ≤ disponível seguro, 1 unidade nunca em dois
canais. Exemplo testado: ADS 10, reserva 2 → ML 4 + Nuvemshop 4 escrito e confirmado na Nuvemshop.

## 10. Proteção de pedidos pendentes

- Webhooks `order/created` e `order/updated` + reconciliação a cada 10 min (`GET /orders?updated_at_min`, sobreposição de 10 min).
- Pedido sempre relido na API; guardados só ID, número, situações, datas e linhas (variante, produto, quantidade, SKU).
- Compromisso na **criação** do pedido (padrão; a Nuvemshop desconta o próprio estoque ao criar) ou no pagamento (`PAID`).
- Cancelado → liberado. Leitura mais antiga não substitui a mais nova.
- Sem envio à ADS: o compromisso fica PENDING_ERP (descontado) até **“Baixa ADS confirmada”** no painel → REFLECTED_IN_ERP
  (não descontado — sem baixa dupla). Pendente além de `pendingReconcileAfterDays` → REQUIRES_RECONCILIATION.
- Sem confirmação além do prazo → aumentos bloqueados nos SKUs afetados.
- A automação de estoque só entra em PILOT/AUTOMATIC com a proteção operante (`read_orders`, webhooks de pedido ativos,
  reconciliação concluída nos últimos 3 intervalos).

## 11. Webhooks

- Eventos cadastrados: `order/created`, `order/updated`, `product/created`, `product/updated`, `product/deleted`.
- HMAC-SHA256 do corpo com o segredo do aplicativo; evento persistido e resposta imediata (limite de 3 s da Nuvemshop).
- Processamento depois da resposta e a cada tick; até 8 tentativas com backoff; falha definitiva gera alerta (a reconciliação cobre).
- Sem loop: `product/updated` só atualiza o catálogo local; se a quantidade é a última escrita pelo integrador → eco
  (`INTEGRATOR_ECHO`); senão → variante marcada para reavaliação. Nenhum webhook enfileira escrita.

## 12. Workers e agendamento

- pg_cron (5 min) → `/api/marketplace/scheduler/tick` → `runNuvemshopTick`: webhooks → pedidos → incertos → preço → estoque → worker de escrita → catálogo incremental (6 h) → saúde.
- Funciona sem painel aberto; não usa `setInterval`.
- Leases: `nuvemshop-tick`, `nuvemshop-price-sync`, `nuvemshop-stock-sync`, `nuvemshop-writer`.
- Worker: compare-and-set antes de escrever (valor remoto mudou → SUPERSEDED), reduções primeiro no lote, 422 de lote →
  repetição isolada por variante, 429 com backoff, preço idempotente repetido em 5xx, **estoque nunca repetido às cegas**
  (incerto → leitura: aplicado / não aplicado / reconciliação). Job RUNNING abandonado (> 2 min) vira UNCERTAIN.
- Jobs de estoque expiram em 10 min e de preço em 30 min se não executados.
- Alertas: fila de webhooks > 15 min, escritas em reconciliação, ≥ 5 falhas na última hora, falha de execução.

## 13. Painel `/nuvemshop/automacoes`

Preço e estoque lado a lado com o modo destacado (Desligado / **SOMBRA — sem escrita** / **PILOTO — só SKUs do piloto** /
**AUTOMÁTICO — escrita real** / PAUSADO), última e próxima execução, vinculadas, participantes, decisões, pré-condições
que faltam. Ações: modos, automático com frase de confirmação, pausar com motivo, reativar, executar simulação,
frequência/escopo/limites/política, seleção de SKUs (piloto/incluir/excluir), revisões de preço, divergências e
reconciliação manual, fila e histórico, execuções com detalhe por variante, proteção de pedidos (cadastrar webhooks,
reconciliar pedidos/catálogo, “Baixa ADS confirmada”) e **Pausa emergencial**. Editor de produto em
`/nuvemshop/catalogo/[id]` e criação a partir da ADS em `/nuvemshop/catalogo/novo`.

O desligamento de emergência pausa as duas automações, cancela os jobs ainda não iniciados, faz o portão recusar
qualquer escrita (inclusive catálogo) e o worker parar antes de cada lote; liberar exige digitar LIBERAR e mantém as
automações pausadas.

## 14. Testes executados

- `tests/nuvemshop-phase2.test.ts`: **33 testes**, todos passando, contra a Nuvemshop simulada:
  - **Produtos:** criação oculta com estoque 0 e vínculo; não recria; SKU duplicado; criação incerta aplicada (reconciliada pelo SKU, sem duplicar) e não aplicada (bloqueia até reconciliar); edição; publicação com confirmação; variante criada/editada; preço manual recusado sob automação; imagens (adicionar, principal, remover com confirmação); ID de variante alterado → vínculo em revisão; rotas protegidas.
  - **Preço:** margem/arredondamento/mínimo; promoção BLOCK/KEEP; mudança expressiva → revisão → aprovação; tabela incorreta; ADS desconhecida/zero/erro; kit; SHADOW sem escrita; PILOT só no piloto; falha parcial (lote isolado, `success:false`); retry em 5xx; pausa/desativação.
  - **Estoque:** saldo positivo (10/2 → 4); zero; desconhecido; ADS fora do ar; reserva; cotas exclusivas; pedido pendente; baixa ADS confirmada sem baixa dupla; cancelamento; leitura antiga; venda entre cálculo e escrita (SUPERSEDED); venda logo após a escrita; timeout não aplicado / aplicado / valor inesperado (reconciliação trava a variante); multidepósito (escreve só na localização associada; duas localizações bloqueiam); variante sem vínculo; atualização duplicada; dois workers; duas execuções; sem escritor concorrente no ML; núcleo sem escrita remota; canal simulado com automação desligada.
  - **Automação:** frase do automático; escopo selecionado; kill switch (cancela fila, bloqueia criação/execução/ativação/catálogo; liberar mantém pausado); agendador completo sem painel; recuperação de worker interrompido; proteção de pedidos; webhooks sem duplicar; rotas do painel.
- Regressão: **suíte completa 438/438** (23 arquivos; os 406 testes anteriores continuam passando — ADS, ML, pedidos ML, sincronizador antigo, Inventory Core, OAuth, site institucional).
- `tsc --noEmit` sem erros; `next build` sem erros.
- **Telas não abertas no navegador:** não havia banco local disponível (Docker parado) e o disco C: estava sem espaço durante a validação.
- Rodar no Windows: `NODE_OPTIONS=--max-old-space-size=4096 npx vitest run --maxWorkers=1`.

## 15. Evidências do piloto

**Nenhum piloto real foi executado** (não autorizado e loja ainda não conectada). Sem escrita em loja real.

## 16. Pendências comerciais ou operacionais

1. Conectar a loja (pendência da Fase 1) com os escopos `read_products`, `write_products` e `read_orders`.
2. Tabela de preço da Nuvemshop definida: **F** (padrão já configurado). Faltam a margem (padrão 0%), o arredondamento (padrão nenhum) e a regra de promoção (padrão não mexer em variante em promoção).
3. Definir a política de cotas do Inventory Core para a Nuvemshop (hoje `ZERO` — a sincronização bloqueia com POLICY_ZERO até mudar).
4. Confirmar com a Nuvemshop/lojista em que momento a loja desconta o estoque (criação × pagamento) — padrão adotado: criação.
5. Confirmar com a Tecdisa quando a ADS baixa o saldo; enquanto os pedidos Nuvemshop não vão à ADS, a baixa precisa ser confirmada no painel.
6. Decidir a transferência de responsabilidade do estoque no ML (§7) para SKUs vendidos nos dois canais.
7. Comportamento de localizações omitidas no `PATCH stock-price` não é documentado: validar no piloto com loja de uma localização primeiro.

## 17. Checklist de ativação

1. Deploy (migration só cria tabelas; automações DISABLED).
2. Portal de Parceiros: escopos `write_products` + `read_orders`; reinstalar/reconectar a loja.
3. Vercel: `NUVEMSHOP_WRITE_ENABLED=true` e `INVENTORY_CORE_MODE=shadow`.
4. Localização ↔ depósito (uma localização por depósito) e filiais ADS ↔ depósito no Estoque central.
5. Política do Inventory Core com cota para a Nuvemshop.
6. Automações › **Cadastrar webhooks** e **Reconciliar pedidos agora**; conferir “proteção operante”.
7. Preço: conferir a tabela **F** e a política → **SOMBRA** → simulação → conferir decisões contra os preços da tabela F na ADS.
8. Estoque: **SOMBRA** → simulação → conferir alvos contra o Estoque central.
9. **PILOTO** com 1–3 SKUs de teste autorizados (sem anúncio ML ativo); validar na loja escrita, releitura, webhooks e uma venda de teste com cancelamento.
10. Preço em **AUTOMÁTICO** (frase de confirmação) com escopo selecionado.
11. Estoque em AUTOMÁTICO somente depois de validar pedidos e cotas no piloto.
12. Expandir por inclusão de SKUs; `ALL_ELIGIBLE` só com nova aprovação.

## 18. Plano de rollback

- Imediato: **Pausa emergencial** no painel (para tudo, cancela a fila).
- Por automação: Pausar ou Desligar (cancela escritas não iniciadas).
- Ambiente: remover `NUVEMSHOP_WRITE_ENABLED` (portão recusa qualquer escrita, independente do banco).
- Código: reverter o deploy; a migration só criou tabelas `nuvemshop_*` (podem ficar). Com a automação DISABLED o
  Inventory Core volta exatamente ao comportamento da Fase 1 e o ML não é afetado.
- Valores já escritos na loja ficam como estão (histórico em `nuvemshop_write_jobs` / `nuvemshop_write_attempts` com o valor anterior de cada variante).
