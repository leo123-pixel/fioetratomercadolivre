# Vinculação de anúncios legados e sincronização de estoque

Integrador ADS ↔ Mercado Livre — Fio & Trato. Fase entregue em 06/11/2026.

## 1. Auditoria do que já existia (preservado)

| Área | Onde | Como foi aproveitado |
|---|---|---|
| Anúncios publicados pelo integrador | `marketplace_listings` (exige rascunho) | Vínculo `EXISTING_LINK`; quantidade publicada atualizada após escrita verificada |
| Vínculo anúncio/SKU → produto ADS (pedidos) | `marketplace_product_mappings` + `src/lib/marketplace/mappings.ts` | **Reutilizado** como vínculo dos legados (tipo `ITEM`); `saveMapping` estendido (origem, composição, limite, quem removeu) |
| Busca de anúncios da conta | `listSellerItemIds` (offset ≤ 1000, depois `search_type=scan`) | Reutilizado na descoberta |
| Multiget de itens | `GET /items?ids=` (20 por chamada) | Reutilizado |
| Saldo ADS | `GET /api/v1/{cnpj}/estoques` (`AdsClient`, `mapStocks`, `upsertStocks`, cache `product_stocks`) | Consulta ao vivo por produto; cache atualizado como efeito colateral |
| Fila, leases, alertas, tick do agendador | `worker_leases`, `raiseAlert`, `runTick` | Jobs com lease/claim; retentativas no tick; alertas de falha/divergência |
| User Products | tag `user_product_seller` em `getCapabilities` | Estoque por `user_product_id` (pool compartilhado) |
| Escrita de estoque no ML | **não existia** | Novo, restrito à quantidade |

Nenhuma alteração foi feita em produção durante o desenvolvimento.

## 2. Arquivos

Novos: `src/lib/stock/{settings,matching,legacy,links,remote,reconcile}.ts`, rotas em `src/app/api/legacy-listings/**` e `src/app/api/stock-sync/**`, tela `src/app/anuncios/vinculacao/*`, `tests/stock-sync.test.ts`, `tests/helpers/stock-mock.ts`, migration `20261110000000_legacy_listings_stock_sync`.

Alterados (mudanças pequenas e compatíveis): `src/lib/meli/api.ts` (resposta expõe `headers`, para o `x-version`), `src/lib/marketplace/mappings.ts` (`saveMapping`/`deactivateMapping` estendidos), `src/lib/marketplace/scheduler.ts` (tick chama `runStockSyncTick`), `src/lib/api.ts` (erro `StockSyncError`), `src/app/api/mappings/[id]/route.ts` (registra quem removeu), `src/app/anuncios/page.tsx` (atalho), `prisma/schema.prisma`, `tests/helpers/pg.ts`, `.env.example`.

## 3. Migração (não destrutiva)

- `legacy_listings` — inventário (um por anúncio/variação): UP, família, SKU, GTINs válidos, marca, código do fabricante, quantidade, logística, origem `INTEGRATOR|EXTERNAL`, sugestão do motor.
- `marketplace_product_mappings` + `deactivated_by`, `max_quantity`, CHECK de `source` (`NOT VALID`: não reavalia linhas antigas).
- `marketplace_mapping_components` — composição de kits/pacotes.
- `legacy_listing_rejections` — sugestões recusadas.
- `stock_sync_groups` — política por produto ADS (reserva, alocação, aprovação para automação).
- `stock_sync_runs` / `stock_sync_proposals` — simulações e propostas.
- `stock_sync_jobs` (índice único parcial: **um job ativo por estoque**) / `stock_sync_attempts` — cada chamada ao ML, sanitizada.
- `stock_sync_history` — auditoria (vínculos, recusas, autorizações, resultados, mudanças de status, políticas, configurações).
- Políticas globais ficam em `app_settings.stock_sync_settings` (não foi criada tabela `stock_sync_policies` separada).

## 4. Endpoints (todos exigem sessão de administrador; escrita exige mesma origem e tem limite por minuto)

| Método | Rota | Função |
|---|---|---|
| GET | `/api/legacy-listings?filter=&q=&page=` | Inventário com vínculo, sugestão, saldo ADS, divergência, situação |
| GET | `/api/legacy-listings/unmapped` | Sem vínculo confirmado |
| POST | `/api/legacy-listings/discover` | Lê a conta (somente leitura no ML); continua de onde parou |
| GET | `/api/legacy-listings/{id}/candidates` | Candidatos + dicas por título (só visuais) |
| POST | `/api/legacy-listings/{id}/map` | Confirma vínculo (`confirm: true`; composição e limite opcionais) |
| DELETE | `/api/legacy-listings/{id}/map` | Remove vínculo (`confirm: true`) |
| POST | `/api/legacy-listings/{id}/reject` | Recusa sugestão |
| POST | `/api/legacy-listings/map-batch` | Lote só de sugestões inequívocas (`confirm: true`) |
| POST | `/api/stock-sync/preview` | Simulação (DRY RUN) |
| POST | `/api/stock-sync/validate` | Reconsulta ADS+ML, resumo e token de confirmação (10 min) |
| POST | `/api/stock-sync/apply` | Cria jobs e aplica (`confirmationToken` + `confirm: true`) |
| GET | `/api/stock-sync/jobs[?id=]` | Jobs (e chamadas ao ML de um job) |
| GET | `/api/stock-sync/history` | Auditoria e execuções |
| GET/PATCH | `/api/stock-sync/settings` | Configurações / homologação / automação |
| GET/PATCH | `/api/stock-sync/groups/{productId}` | Política do grupo de estoque |
| GET | `/api/stock-sync/runs/{id}` | Propostas de uma simulação |

## 5. Tela `/anuncios/vinculacao`

Filtros: não vinculados, sugestão pendente, ambíguos, vinculados, com divergência, estoque ADS zero, sem estoque ADS conhecido, vários anúncios por produto, não gerenciável pela API, aguardando sincronização. Por linha: imagem, item/variação/UP, título, SKU, GTIN, status, quantidade ML, produto ADS (vinculado ou sugerido), quantidade ADS, diferença, confiança, situação do vínculo e da sincronização. Ações: buscar produto ADS, escolher candidato, confirmar, rejeitar, remover (com confirmação), composição de kit, limite por anúncio, política do grupo, vincular em lote (só inequívocos), simular, validar, **“Sincronizar estoque selecionado”**, histórico de atualizações e configurações.

## 6. Motor de correspondência

Prioridade: vínculo existente → `SKU_MATCH` (`ADS-<id>` ou SKU já validado: alta; SKU numérico = produtoId: média) → `GTIN_MATCH` (só GTIN com dígito verificador válido; alta) → `MANUFACTURER_MATCH` (código igual + marca compatível com o fornecedor: média; sem marca no anúncio: baixa; marca incompatível: descartado) → título (apenas dica visual). Critérios diferentes concordando elevam a confiança. Mais de um produto = **ambíguo** (lote recusa). Produto marcado como kit na ADS exige composição. A origem gravada é recalculada no servidor.

## 7. Modelos de estoque

| Modelo | Detecção | Escrita |
|---|---|---|
| `CLASSIC` | sem UP, sem variações | `PUT /items/{id}` `{available_quantity}` |
| `CLASSIC_VARIATION` | variação vinculada | `PUT /items/{id}` com **todas** as variações (só a alvo com quantidade) |
| `UP_SHARED_ITEM` | UP sem estoque distribuído (`/stock` 404) | `PUT /items/{id}` de um anúncio; o ML replica no UP |
| `UP_SELLING_ADDRESS` | `GET /user-products/{id}/stock` com `selling_address` | `PUT …/stock/type/selling_address` `{quantity}` + `x-version`; 409 → reconsulta e reavalia |
| `MULTI_WAREHOUSE` | localização `seller_warehouse` | **não elegível** (exige mapeamento depósito ↔ filial) |
| `FULFILLMENT` | `logistic_type=fulfillment` ou só `meli_facility` | **não elegível** |

Encerrado, excluído, em revisão ou inexistente: nunca atualizado nem reaberto.

## 8. Estoque compartilhado

“Estoque” (pool) = o que o ML controla: anúncios do mesmo User Product formam **um** estoque (uma escrita). Um produto ADS que abastece vários estoques independentes fica **bloqueado** (`ALLOCATION_REQUIRED`) até o grupo receber a regra `SPLIT_EVEN` (divisão inteira; soma ≤ saldo). Limite por anúncio (`max_quantity`) sempre reduz. Kits: mínimo entre componentes de ⌊parcela ÷ quantidade por venda⌋.

```
disponível = max(0, ⌊saldo ADS⌋ − reserva − ⌈pedidos ML não refletidos na ADS⌉)
```

Pedidos não refletidos: linhas mapeadas de pedidos não cancelados na janela (padrão 7 dias) sem envio `SENT` à ADS **do mesmo ambiente**. Saldo ausente na ADS = desconhecido (nunca zero).

## 9–12. Simulação, aplicação e controles

- **Simulação**: consulta real à ADS e ao ML, grava propostas, nenhum PUT.
- **Validação**: reconsulta tudo, marca como `STALE` o que mudou, verifica jobs em andamento e emite token HMAC ligado às propostas e quantidades.
- **Aplicação**: token + `confirm: true` + “origem do saldo confirmada”; registra quem autorizou; job idempotente (`manual:<proposta>`), reavaliação imediatamente antes da escrita (se a quantidade calculada mudou, nada é enviado), escrita, **releitura** (até 3 vezes) e resultado `SUCCEEDED` ou `DIVERGED` — HTTP 200 sem efeito não conta como sucesso. Timeout/5xx: confere e reagenda com backoff (máx. 4 tentativas). Mudanças de status (ex.: pausa por falta de estoque em 0) ficam no histórico.
- **Proteções contra estoque inflado** (só para aumento): pausado manualmente (só reduz), pedido recente sem produto ADS, venda há menos de 10 min, queda no ML sem pedido registrado, saldo ADS acima da idade máxima.
- Sem atualização em massa sem aprovação: limite por execução (padrão 30) e seleção explícita.

**Evidência de pilotos:** nenhuma atualização real foi feita — não houve autorização para escrever na conta.

## 13. Relatório de testes

`tests/stock-sync.test.ts`: 31 testes (os 30 cenários exigidos + código do fabricante), PostgreSQL embarcado com as migrations reais e ML/ADS simulados. Suíte completa do projeto: 266/266 passando (13 arquivos); `tsc --noEmit` e `next build` sem erros.

## 14. Pendências

1. **Confirmar com a ADS** se `/estoques` desconta reservas/pedidos em aberto e em que momento um pedido baixa o saldo (no envio, no faturamento?). A regra de pedidos pendentes assume “até o envio `SENT`”.
2. Rodar a migration em produção (deploy) e fazer a primeira leitura da conta.
3. Piloto: 1 a 3 anúncios de redução, com acompanhamento no ML.
4. Multiorigem com `seller_warehouse`: exige mapeamento `store_id` ↔ filial ADS (não implementado).
5. Pedidos de anúncios-kit enviados à ADS continuam saindo com o produto principal do vínculo (composição ainda não vai para o pedido).
6. Variações em anúncios User Products não foram observadas na conta real; o tratamento segue a documentação.
7. A tela não foi verificada em navegador contra dados reais (sem a migration aplicada).

## Procedimento para habilitar a sincronização automática (futuro)

1. Confirmar a pendência 1 com a ADS e marcar “O saldo da ADS corresponde ao estoque vendável”.
2. Fazer ao menos uma sincronização **manual** verificada com sucesso (piloto) e clicar em “Registrar homologação do fluxo”.
3. Aprovar critérios operacionais (reserva, janela de pedidos, intervalo, limite por execução).
4. Definir `STOCK_AUTO_SYNC_ENABLED=true` na Vercel e reimplantar.
5. Aprovar os grupos de estoque (produto a produto) em “Aprovado para sincronização automática”.
6. Clicar em “Ativar automação”. Para parar: “Desativar automação” (efeito imediato) ou remover a variável.
