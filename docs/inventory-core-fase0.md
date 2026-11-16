# Fase 0 — Inventory Core (modo sombra)

Núcleo central de estoque multicanal, independente dos canais, entregue em **SHADOW MODE**. Ele lê dados, calcula,
simula e grava somente nas tabelas `inventory_*`. Não escreve no Mercado Livre, na Nuvemshop nem na ADS, e não
substitui nem altera o sincronizador de estoque atual (`src/lib/stock/reconcile.ts`).

---

## 1. Matriz de auditoria

| Área | Onde está | O que existe hoje | Risco / observação | Uso no Inventory Core |
|---|---|---|---|---|
| Integração ADS | `src/lib/ads/client.ts` | `AdsClient` (GET paginado, timeout, backoff, indisponibilidade), `adsCall` (GET/POST), bloqueio de escrita por host (`assertAdsWriteAllowed`) | Escrita só em homologação, salvo `ADS_PRODUCTION_WRITE_ENABLED` | Somente `getAllPagesForIds("estoques")` (GET) na leitura ao vivo opcional |
| Consulta de estoque ADS | `GET /api/v1/{cnpj}/estoques` → `mapStocks` → `product_stocks` | Saldo `estoque` por `filialId`; ausência de linha = desconhecido; `ultVnd` = última venda | A ADS **não informa** físico × reservado; semântica do saldo **não confirmada** com a Tecdisa | Cache `product_stocks` (padrão) ou leitura ao vivo **sem gravar no cache** |
| Estoque por filial | `stock_sync_settings.branchIds` | `null` = **soma todas as filiais** devolvidas | Pode somar depósitos incompatíveis | Filial só entra se `MAPPED`; soma só dentro do mesmo depósito |
| Pedidos ML | `marketplace_order_inbox/_items` (webhook + recuperação) | Linhas com vínculo `MAPPED/UNMAPPED`, `mapping_id`, pack | — | Lidos do banco local (nenhuma chamada ao ML) |
| Criação de pedido ADS | `src/lib/ads/order-submission.ts` | Envio **manual**, idempotente por `idExterno`, write-ahead, `UNKNOWN` sem reenvio | Pack: o envio fica só no pedido principal | Situação do envio vira fato (`SENT`/incerto/falha) |
| Momento da baixa na ADS | — | **Desconhecido.** O sincronizador atual assume que `SENT` = baixado | Se a ADS só baixa no faturamento, o atual **superexpõe** entre o envio e o faturamento | `SENT` **não** é baixa; a evidência é configurável (situação ADS) |
| Mapeamento SKU/produto | `marketplace_product_mappings` + `marketplace_mapping_components`; `marketplace_listings` | Vínculo por anúncio/variação, SKU validado, composição de kit, `max_quantity` | Sugestões nunca contam | Só vínculos confirmados (`trusted`) participam |
| Vários anúncios / variações | `legacy_listings` + `POOL_KEY_SQL` | Pool por User Product, variação ou anúncio; `EXCLUSIVE` bloqueia, `SPLIT_EVEN` divide | — | Mesma regra na tradução cota → anúncio |
| Kits | `marketplace_mapping_components`; `products.raw_payload.kit` | Kit na ADS exige composição | Pedido de kit enviado à ADS sai com o produto principal (pendência existente) | Venda de kit reserva os componentes |
| Sincronização ML | `src/lib/stock/reconcile.ts` → `remote.ts executeWrite` | **Único escritor de estoque no ML**: jobs manuais aprovados (token) e automação (env + homologação + ativação) | — | **Não chamado nem alterado** |
| Webhooks | `/api/webhooks/mercadolivre` → `marketplace_webhook_events` (UNIQUE `_id`) | Fila no Postgres, coalescência, `last_updated` | — | Não tocados; nenhuma escrita adicionada |
| Filas / jobs | `import_jobs`, `marketplace_webhook_events`, `stock_sync_jobs`; `worker_leases`; pg_cron 5 min | `FOR UPDATE SKIP LOCKED`, leases, retentativa | — | Lease `inventory-shadow`; execução sob demanda (não entra no tick) |
| PostgreSQL | Supabase (pooler), Prisma raw SQL via `Sql` | CHECKs, índices parciais, migrations SQL | Pooler em modo transação | Só advisory locks **de transação** |
| Logs | `src/lib/logger.ts` (JSON sanitizado) | — | — | Reutilizado |
| Concorrência | leases, `SKIP LOCKED`, índice único "um job ativo por estoque" | — | — | Advisory lock por pool, versões, unicidade |
| Idempotência | `_id` do webhook, `idExterno`, chaves de job | — | — | Chaves únicas em reservas, movimentações, transferências e outbox |

**Quem escreve estoque no Mercado Livre hoje:** só `processStockJobs` em `src/lib/stock/reconcile.ts`, por
`executeWrite` em `src/lib/stock/remote.ts`, para jobs **manuais** aprovados ou para a **automação**, que exige
`STOCK_AUTO_SYNC_ENABLED=true` + homologação + ativação no painel. A publicação (`src/lib/publish/worker.ts`) define
a quantidade inicial só ao criar o anúncio. O sincronizador de preço (`src/lib/stock/prices.ts`) escreve preço, não
quantidade. O Inventory Core não ganhou permissão alguma.

## 2. Arquitetura existente e proposta

```
EXISTENTE (inalterado)
ML ─webhook─► marketplace_webhook_events ─► pedidos/anúncios (somente leitura do ML)
ADS ─GET /estoques─► product_stocks
stock/reconcile.ts:  disponível = ⌊ADS⌋ − reserva − pedidos sem envio SENT (7 dias)  ──PUT──► Mercado Livre
order-submission.ts: envio manual de pedido ──POST──► ADS

NOVO (somente leitura + tabelas inventory_*)
                ┌──────────────────────── InventoryCore (src/lib/inventory) ────────────────────────┐
 product_stocks │ identity.ts  SKU físico (ADS-<id>) × depósito = pool                               │
 ADS GET (opc.) │ ingest.ts    pedidos → compromissos (fatos → estado)                                │
 legacy_listings│ position.ts  posição segura      allocation.ts  cotas exclusivas + plano seguro     │
 mappings       │ shadow.ts    reconciliação sombra, divergências, propostas (write_blocked)          │
 order_inbox    │ ledger.ts    livro imutável, outbox, auditoria, locks                                │
 ads_submissions│ transfer.ts  protocolo de transferência (executor simulado | portão bloqueado)      │
                │ adapters/    InventoryChannelAdapter: Mercado Livre (leitura) · Nuvemshop (simulado) │
                └───────────── mode.ts: assertRemoteWriteAllowed() SEMPRE lança ─────────────────────┘
                                         │
                                 /estoque/controle-central · /api/inventory/*
```

Regras de estoque ficam no núcleo; os adaptadores só traduzem (unidades físicas por produto ↔ anúncios do canal).

## 3. Fluxo real de baixa de estoque (venda → ADS → ML)

1. **Venda no ML.** O ML reduz sozinho o `available_quantity` do anúncio.
2. **Recebimento.** O webhook `orders_v2` (ou a recuperação a cada 30 min) grava o pedido em `marketplace_order_inbox/_items`, com vínculo ao produto ADS.
3. **Integração ADS.** Hoje é **manual**: o operador envia em `/pedidos/:id`. `ads_order_submissions.status = SENT` só indica que o pedido **existe** na ADS.
4. **Movimentação no ERP.** **Não se sabe** em que momento a ADS baixa o saldo devolvido por `/estoques` (criação, separação, faturamento?). `GET /pedidos/status` informa a situação ("Em análise", "Faturado", "Nota Emitida"…).
5. **Sincronização ML.** O sincronizador atual lê `/estoques` e desconta só os pedidos **sem** envio `SENT` dos últimos 7 dias.

**Janelas em que a venda está no integrador mas não no saldo ADS** (todas tratadas como `PENDING_ERP` ou `REQUIRES_RECONCILIATION` no núcleo):

- pedido recebido e ainda não enviado à ADS;
- pedido enviado (`SENT`) e ainda não baixado: **o sincronizador atual já para de descontar aqui**, o que gera risco de superexposição;
- envio com resultado incerto (`SENDING`/`UNKNOWN`);
- pedido com mais de 7 dias sem envio: o atual ignora;
- pedido membro de pack: o envio fica no pedido principal. O atual continua descontando os demais membros, o que é conservador; o núcleo trata o pack corretamente.

## 4. Modelo de dados implementado

Migration `prisma/migrations/20261116000000_inventory_core_shadow/migration.sql`. Só cria tabelas; nenhuma tabela
existente é alterada.

| Tabela | Função | Garantias |
|---|---|---|
| `inventory_locations` | filial ADS → depósito (`MAPPED/UNMAPPED/EXCLUDED`) | versão; código validado |
| `inventory_skus` | identidade do SKU físico (`ADS-<produtoId>`, unidade, escala `INTEGER/DECIMAL`, kit na ADS) | únicos por produto, ADS e código |
| `inventory_pools` | SKU × depósito: saldo aceito, pendentes, reserva, disponível seguro, confiabilidade | `version`; CHECKs ≥ 0; `KNOWN` exige quantidade |
| `inventory_snapshots` | histórico das leituras ADS (`accepted=false` = mais antiga que a vigente) | — |
| `inventory_reservations` | compromissos por canal × pedido × linha × produto físico; `facts` + `state` | **único (canal, pedido, linha, produto)**, chave idempotente, `version` |
| `inventory_movements` | livro de movimentações | **somente inclusão** (gatilho), chave idempotente |
| `inventory_allocation_policies` | políticas versionadas (global e por produto) | uma ativa por escopo; versão única |
| `inventory_channel_allocations` | cota desejada × confirmada × pendente por pool e canal | CHECKs ≥ 0; `version` |
| `inventory_quota_transfers` | transferências (passos em JSON) | **`CHECK (simulated)`**; uma aberta por pool |
| `inventory_reconciliation_runs` | execuções sombra | `CHECK (mode = 'SHADOW')` |
| `inventory_discrepancies` | divergências (uma aberta por impressão digital) | índice único parcial |
| `inventory_sync_proposals` | propostas por pool/canal + tradução por anúncio | **`CHECK (write_blocked)`** |
| `inventory_outbox_events` | outbox transacional | **status só `PENDING` ou `SUPPRESSED_SHADOW`** |
| `inventory_audit_logs` | ações administrativas (política, depósitos, simulações) | — |

Quantidades: `DECIMAL(14,3)`, como a ADS e os pedidos. Cotas e disponível são inteiros (`⌊saldo⌋`). Não foi criada
tabela própria de "inbox": a deduplicação de eventos externos usa as chaves únicas de reservas e movimentações.

## 5. Serviços criados (`src/lib/inventory/`)

| Arquivo | Responsabilidade |
|---|---|
| `mode.ts` | `INVENTORY_CORE_MODE`, erros, **portão de escrita remota** (`assertRemoteWriteAllowed` sempre lança) |
| `allocation.ts` | `allocate` (cotas exclusivas), `planQuotas` (plano seguro com exposição), `distributeWithinChannel` (anúncios, kits, limites) |
| `position.ts` | `computePosition` (disponível seguro e confiabilidade) |
| `reservations.ts` | fatos → estado (`applyEvent`, `deriveState`) |
| `transfer.ts` | protocolo de transferência; executor simulado e executor "real" bloqueado |
| `identity.ts` | SKUs e pools |
| `ingest.ts` | `recordOrderEvents` (entrada única de eventos de pedido) e `ingestMercadoLivreOrders` |
| `ledger.ts` | livro, outbox, auditoria, `withPoolLock` |
| `settings.ts` | configuração, políticas versionadas, depósitos |
| `shadow.ts` | `runShadowReconciliation` |
| `transfer-service.ts` | transferência simulada persistida, cancelamento |
| `queries.ts` | leituras do painel |
| `adapters/types.ts` | `InventoryChannelAdapter` (`getChannelInventory`, `getProductMappings`, `validateInventoryCapability`, `prepareStockUpdate`, `applyStockUpdate`, `verifyStockUpdate`) |
| `adapters/mercadolivre.ts` | leitura via `loadPools`/`readRemoteState` existentes; `applyStockUpdate` → portão |
| `adapters/nuvemshop.ts` | simulado, sem rede; `applyStockUpdate` → portão |

## 6. Endpoints (todos exigem administrador; os que gravam exigem mesma origem e têm limite por minuto)

| Método | Rota | Função |
|---|---|---|
| GET | `/api/inventory/overview` | modo, contagens, divergências, compromissos, última execução |
| GET · POST | `/api/inventory/runs` | histórico · reconciliação sombra (`{ live?, productIds? }`) |
| GET | `/api/inventory/runs/:id` | execução + propostas |
| GET | `/api/inventory/positions` | posições (`q`, `reliability`, `alerts`, `page`) |
| GET | `/api/inventory/movements` | livro (`q` = SKU, código ADS ou pedido; `type`) |
| GET | `/api/inventory/discrepancies` | divergências (`status`, `severity`, `type`) |
| GET | `/api/inventory/reservations` | compromissos (`state` separado por vírgula, `q`) |
| POST | `/api/inventory/simulate` | simulador puro (não grava nada) |
| GET · POST | `/api/inventory/transfers` | transferências · simular transferência |
| POST | `/api/inventory/transfers/:id/cancel` | cancelar transferência aberta |
| GET · PUT | `/api/inventory/policy` | versões · nova versão (`expectedVersion`) |
| GET · PUT | `/api/inventory/locations` | filiais → depósitos |
| GET · PATCH | `/api/inventory/settings` | semântica da baixa e parâmetros |

Com o modo desativado, reconciliação e transferência respondem **409 `inventory_core_disabled`**.

## 7. Regras de alocação

1. Mínimos por prioridade, sem passar do disponível.
2. Alvos por prioridade: `PERCENT` → ⌊disponível × %⌋; `FIXED` → valor; ambos limitados pelo `max`.
3. Sobra do arredondamento (`PRIORITY`): no máximo 1 unidade por canal percentual que perdeu fração, por prioridade. `UNALLOCATED` deixa a sobra sem canal.
4. `ZERO`, canal desativado e canal novo recebem 0.
5. Invariantes verificados a cada cálculo: inteiros ≥ 0 e Σ ≤ disponível seguro. Estoque 1 com N canais vai para **um** canal.
6. **Plano seguro** (`planQuotas`): reduções sempre; aumentos só com a folga ainda não exposta em canal algum (o anunciado continua exposto até a redução ser confirmada). Dados degradados permitem só reduzir. Exposição desconhecida bloqueia aumentos nos outros canais e limita o próprio canal à folga.
7. **Dentro do canal**: um produto em vários estoques independentes do ML só é dividido com `SPLIT_EVEN`. Kits usam o mínimo entre os componentes de ⌊parcela ÷ quantidade por venda⌋. `max_quantity` limita.

Política padrão (migration): Mercado Livre 100%, Nuvemshop `ZERO`. A cota é **limite de exposição comercial**, não
reserva física no ERP (registrado em cada movimentação `QUOTA_ALLOCATED`).

## 8. Reserva de segurança

`política do produto` → `política global` → `stock_sync_groups.safety_reserve` → `stock_sync_settings.defaultSafetyReserve`
(herda da sincronização atual quando a política deixa `NULL`).

`disponível seguro = max(0, ⌊ADS (filiais mapeadas do depósito)⌋ − ⌈compromissos PENDING_ERP + REQUIRES_RECONCILIATION⌉ − reserva)`

Saldo ausente ou falha na ADS dá disponível **desconhecido** (`null`), nunca zero. Reservas internas da ADS não são
descontadas de novo: já estão embutidas no saldo. Estoque Full não entra.

## 9. Controle de concorrência

- `withPoolLock`: transação + `pg_advisory_xact_lock(hashtext('inventory:pool:<chave>'))`. Funciona entre instâncias e no pooler em modo transação, e é liberado no commit.
- Lock da linha do pool (`FOR UPDATE`) + `UPDATE … WHERE version = $v` (otimista) em pools, reservas, cotas, políticas e depósitos.
- Lease `inventory-shadow` (`worker_leases`): uma reconciliação por vez; expira sozinho se a instância morrer.
- Nenhuma chamada externa dentro de transação. Na transferência, cada passo é gravado na própria transação antes do seguinte.
- **Achado da validação em Postgres real:** `pg_advisory_xact_lock` devolve `void`, e o `$queryRawUnsafe` do Prisma falha com isso (o PGlite aceita). Os locks usam `execute()`, e um teste estático impede a regressão.

## 10. Estados das reservas

| Estado | Descontado? | Quando |
|---|---|---|
| `PENDING_ERP` | sim | venda registrada; sem evidência de baixa (inclusive com envio `SENT`) |
| `REQUIRES_RECONCILIATION` | sim | envio incerto; cancelado no canal depois do envio; pendente além de N dias; evento da ADS sem pedido |
| `REFLECTED_IN_ERP` | não | situação ADS configurada como evidência (ex.: "Faturado"), ou política "a ADS baixa na criação" + `SENT` |
| `RELEASED` | não | cancelado antes da ADS; cancelado na ADS; devolução de venda nunca baixada |

O estado é **função pura dos fatos acumulados**, não de uma sequência de transições. Por isso é idempotente,
independe da ordem de chegada e não oscila entre execuções. `REFLECTED_IN_ERP` nunca volta a ser descontado; `RELEASED`
é terminal.

## 11. Idempotência

- Reserva: chave `canal:pedido:linha:produto` (única) e unicidade (canal, pedido, linha, produto).
- Movimentação: chave única por fato, estado, snapshot, cota (versão do pool) e divergência. Repetir não grava de novo.
- Outbox: chave igual à da movimentação de cota.
- Transferência: `idempotency_key` única; repetir devolve a mesma.
- Execução repetida sem mudança de dados: **zero** movimentações novas e versões de cota inalteradas (testado).

## 12. Painel `/estoque/controle-central`

Abas: **Posições** (SKU, produto, depósito/filiais, estoque ADS *real*, não refletido na ADS, reserva, disponível
seguro, cota ML proposta, anunciado ML *real*, diferença, cota Nuvemshop *simulada*, não alocado, confiabilidade com
motivos, alertas, última consulta; filtros e busca), **Simulador de cotas**, **Divergências**, **Pedidos pendentes**,
**Movimentações** (por SKU, código ou pedido), **Reconciliações** (botão de execução, histórico, propostas e tradução
por anúncio) e **Configuração** (filiais → depósitos, política versionada, semântica da baixa, transferência simulada).
Valores simulados têm borda tracejada e rótulo; o topo mostra "Escrita em canais e ERP: bloqueada". O menu ganhou o
item "Estoque central".

## 13. Simulações

- **Cotas** (`POST /api/inventory/simulate`): parte de um pool real ou de valores manuais; mostra posição, cota da política, cota segura agora, anunciado e exposição no pior caso. Nada é gravado.
- **Transferência** (`POST /api/inventory/transfers`): protocolo completo com resultado roteirizado de cada etapa remota (confirmada, falha ou incerta). Os passos ficam persistidos e as cotas reais não mudam.
- **Venda Nuvemshop**: `recordOrderEvents(..., simulated: true)` registra a venda sem entrar na posição real (usado nos testes).

## 14. Relatório de divergências

| Tipo | Gravidade | Significado |
|---|---|---|
| `OVER_EXPOSED` | crítica | anunciado no ML acima do disponível seguro |
| `UNMAPPED_ORDER_LINE` | crítica | pedido sem produto ADS (não reservável; bloqueia aumento) |
| `ADS_UNAVAILABLE` | crítica | falha de consulta à ADS (saldo desconhecido) |
| `WAREHOUSE_WITHOUT_BRANCH` | crítica | depósito sem filial mapeada |
| `CURRENT_SYNC_PENDING_DIFFERS` | atenção / info | o núcleo e o sincronizador atual descontam quantidades diferentes |
| `RESERVATION_RECONCILIATION` | atenção | compromisso exige conferência (continua descontado) |
| `ADS_STOCK_UNKNOWN`, `UNMAPPED_LOCATION`, `MAPPING_CONFLICT` | atenção | dado faltante ou não confiável |
| `STALE_SNAPSHOT`, `STOCK_IN_UNMAPPED_BRANCH`, `ALLOCATION_REQUIRED` | info | saldo antigo, saldo fora do depósito, vários anúncios sem regra de divisão |

Divergências não observadas numa execução completa são encerradas (`STOCK_RECONCILED` no livro).

**Exemplo da validação local** (banco de demonstração, não é produção): o shampoo tinha 10 na ADS, 3 vendidos e não
refletidos, reserva de 1, ou seja, 6 seguros. O ML anunciava 9 + 2 (kit), total 11, com o Full (40) excluído:
`OVER_EXPOSED` em 5. O sincronizador atual descontaria só 1 pendente; o núcleo desconta 3, porque um pedido `SENT`
não tem prova de baixa.

## 15. Testes executados

`npm test`: **380/380** (20 arquivos). Eram 306 antes da fase; foram acrescentados 74 em três arquivos novos:

- `tests/inventory-rules.test.ts` (35, puros): exemplo 10/2 → 4+4, zero, desconhecido, menor que o número de canais, arredondamento, fixa, mínimo/máximo/prioridade, cota zero/novo canal, canal desativado, regras inválidas, plano de redistribuição, degradação, exposição desconhecida, canal indisponível, vários anúncios, kit, posição segura, estados, devolução, eventos fora de ordem, idempotência, protocolo de transferência (sucesso, falha, incerteza, recusa, portão), modo. **Propriedades**: 5.000 combinações aleatórias com semente de saldo, reservas, segurança, políticas e exposição. Nenhuma alocação passa do disponível seguro, nenhuma é negativa ou fracionária, e o plano nunca piora a exposição. Também: permutações de eventos produzem o mesmo estado, e 1 unidade nunca entra em duas cotas. (O teste de propriedade encontrou um caso real, já corrigido: canal com exposição desconhecida não respeitava a folga.)
- `tests/inventory-core.test.ts` (34, PostgreSQL embarcado com as migrations reais): estoque positivo, zero e desconhecido; reserva herdada e própria; múltiplas filiais e depósitos incompatíveis; depósito sem filial; Full; múltiplos anúncios e variações; kit; saldo fracionário; venda ML; pedido já baixado; pedido não refletido; política "baixa na criação"; pack; cancelamento antes e depois da ADS; devolução; fora de ordem; webhook duplicado; duas vendas simultâneas e o mesmo pedido concorrente; venda Nuvemshop simulada; pedido sem vínculo; pendente antigo; falha ADS; leitura ao vivo só com GET e sem gravar no cache; snapshot antigo; falha/desconhecido do ML; dois workers; worker reiniciado; transferência; atualização incerta; executor real bloqueado; versões de política; garantias do banco; desativação; modo inválido; **varredura estática** (nenhum módulo do núcleo importa ou chama escrita do ML, da ADS ou do sincronizador atual).
- `tests/inventory-api.test.ts` (5): autenticação, mesma origem, reconciliação pela API, modo desativado, simulador sem gravação, versão de política, validação.

Além disso: `tsc --noEmit` sem erros e `next build` sem erros. As migrations foram aplicadas com `prisma migrate deploy`
num **PostgreSQL 16 real**, e o painel foi exercitado no navegador (Playwright) contra esse banco: reconciliação
`COMPLETED`, **0 requisições a hosts externos**, 0 erros de console, sem rolagem horizontal da página em 390 px.

## 16. Evidências de não regressão

- Os 306 testes anteriores continuam passando sem alteração: login administrativo, OAuth ML, catálogo e importação, imagens, publicação, preços, estoque/sincronizador atual, pedidos ML, envio ADS, webhooks e eventos, workers e agendador, site institucional.
- Arquivos existentes alterados (mínimo): `src/lib/api.ts` (mapear `InventoryError` → JSON), `src/app/(admin)/layout.tsx` (item de menu), `src/app/(admin)/globals.css` (estilos novos, só acréscimos), `tests/helpers/pg.ts` (limpar tabelas novas).
- Nenhuma alteração em `src/lib/stock/*`, `src/lib/ads/*`, `src/lib/meli/*`, `src/lib/marketplace/*`, webhooks, agendador ou `vercel.json`. O núcleo não roda no tick do agendador.
- Os testes verificam que `stock_sync_*` e `product_stocks` permanecem intocados nas execuções sombra.

## 17. Pendências

1. **Confirmar com a Tecdisa** quando a ADS baixa o saldo devolvido por `/estoques` e quais situações de `/pedidos/status` comprovam a baixa. Depois, preencher "situações que comprovam a baixa" ou marcar "a ADS baixa ao criar o pedido".
2. **Mapear filiais.** Sem `branchIds` na sincronização atual, nenhuma filial fica `MAPPED` sozinha e os pools ficam bloqueados até o mapeamento em Configuração.
3. Devoluções (`claims`/`returns` do ML) não são lidas pelo sistema atual. O núcleo já trata o fato `ORDER_RETURNED`, mas falta a fonte.
4. Cancelamento na ADS só é detectado quando alguém consulta a situação (`refreshAdsStatus`). Não há leitura periódica.
5. Reconciliação sombra é sob demanda (botão ou API). Agendar (ex.: pg_cron a cada 30 min) depois de observar o tempo de execução em produção.
6. `prisma/schema.prisma` não ganhou os modelos `inventory_*`: o núcleo usa SQL parametrizado, e `migrate deploy` usa só a SQL. Adicionar os modelos se for usar `prisma migrate dev` localmente.
7. Pedidos de kit enviados à ADS continuam saindo com o produto principal (pendência anterior). Afeta a semântica de baixa dos componentes.
8. Divergências `OVER_EXPOSED` são **informativas**: corrigir passa pelo sincronizador atual, que segue como dono da escrita.

## 18. Plano seguro para integrar a Nuvemshop

1. Fase 1 (leitura): implementar `NuvemshopInventoryAdapter` com `getChannelInventory`/`getProductMappings` reais (produtos e variantes ↔ SKU `ADS-<id>`) e manter `applyStockUpdate` no portão. A cota segue `ZERO`; observar divergências.
2. Pedidos Nuvemshop entram por `recordOrderEvents(channel: "nuvemshop")`, com a mesma deduplicação e os mesmos estados.
3. Definir política por produto (ex.: 50/50 ou fixa) só para um piloto de poucos SKUs com estoque alto.
4. Fase de escrita (exige nova migration e decisão explícita): liberar o portão **só** para `nuvemshop`, sempre via outbox, sempre com `verifyStockUpdate` por leitura antes de marcar `confirmed`, e a Nuvemshop recebendo apenas a folga não exposta (o plano já garante isso).
5. Toda redistribuição ML ↔ Nuvemshop pelo protocolo de transferência (reduzir, confirmar, só então aumentar).

## 19. Plano de migração futura do Mercado Livre ao Inventory Core

1. Rodar o modo sombra em produção e comparar diariamente as propostas do núcleo com os jobs do sincronizador atual (`CURRENT_SYNC_PENDING_DIFFERS`, `OVER_EXPOSED`).
2. Resolver as pendências 1 e 2 e chegar a zero divergências inexplicadas por algumas semanas.
3. Fazer o sincronizador atual usar o disponível do núcleo (compromissos em vez de "sem envio SENT"), mantendo-o como o **único escritor**: mudança pequena e reversível em `pendingConsumption`.
4. Depois de estabilizar, mover a escrita do ML para `MercadoLivreInventoryAdapter.applyStockUpdate` (reaproveitando `buildWrite`/`executeWrite`, verificação e x-version), despachada pelo outbox, e desligar a automação antiga. Isso exige uma migration que libere o outbox, uma flag explícita e um piloto por grupo de produtos.

## Configuração e implantação

```bash
# Vercel → Settings → Environment Variables (Production)
INVENTORY_CORE_MODE=shadow     # ausente ou "disabled" = desativado; qualquer outro valor = desativado
```

O deploy aplica a migration (`npm run vercel-build` → `prisma migrate deploy`). A migration só cria tabelas. Para
desligar, remova a variável ou use `disabled`: o painel continua mostrando o histórico.
