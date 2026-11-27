# Retenção do histórico de sincronização

Em 27/11/2026 o banco (Supabase, plano gratuito) passou do limite de 0,5 GB. Quatro tabelas de diagnóstico das
automações somavam ~418 MB, porque cada execução gravava uma linha por variante/anúncio e nada era apagado:

| Tabela | Tamanho | O que guarda |
|---|---|---|
| `stock_sync_proposals` | 181 MB | propostas do estoque automático ADS → ML |
| `nuvemshop_sync_items` | 129 MB | decisão por variante de cada execução Nuvemshop (preço e estoque) |
| `inventory_sync_proposals` | 75 MB | propostas do Inventory Core por pool/canal |
| `price_sync_proposals` | 33 MB | propostas do preço automático ADS → ML |

## O que a retenção apaga

`src/lib/maintenance/retention.ts`, chamada no começo do tick do agendador (no máximo 1×/h, até 20 s, em lotes de
10 mil; a primeira limpeza grande termina ao longo de alguns ticks).

| Tabela | Apaga depois de | Nunca apaga |
|---|---|---|
| `nuvemshop_sync_items` | 3 dias (30 se ligada a uma escrita) | a última de cada variante × tipo |
| `inventory_sync_proposals` | 3 dias | — (o núcleo só lê as da execução atual) |
| `stock_sync_proposals` | 3 dias (era 7 até 27/11/2026) | abertas (PROPOSED/APPROVED), ligadas a `stock_sync_jobs`, a última de cada estoque e a última com modelo de estoque conhecido |
| `price_sync_proposals` | 7 dias | abertas (PROPOSED/APPLYING), preços aplicados (`applied_at`), a última de cada anúncio |

Ledger, snapshots, reservas e movimentos do Inventory Core não são tocados. O último resultado fica em
`app_settings.history_retention_last`.

## Para o tamanho cair no painel do Supabase (uma vez)

Apagar linhas não encolhe o arquivo: o Postgres só reaproveita o espaço. Depois que a primeira limpeza terminar
(`history_retention_last.complete = true`), rodar no SQL Editor do Supabase, de preferência fora do horário da ADS:

```sql
SELECT value FROM app_settings WHERE key = 'history_retention_last';
```

```sql
VACUUM FULL ANALYZE stock_sync_proposals;
VACUUM FULL ANALYZE nuvemshop_sync_items;
VACUUM FULL ANALYZE inventory_sync_proposals;
VACUUM FULL ANALYZE price_sync_proposals;
```

`VACUUM FULL` reescreve a tabela e a bloqueia enquanto roda (segundos, para estes tamanhos): uma sincronização que
cair nesse momento espera ou falha e é refeita no tick seguinte. Se o editor reclamar de transação, rodar um comando
por vez.

## Ajuste de 27/11/2026: propostas de estoque ML com 3 dias

Depois do `VACUUM FULL`, `stock_sync_proposals` ainda tinha ~100 MB, quase tudo da última semana (a sincronização
de estoque grava uma proposta por estoque a cada ciclo). A retenção caiu de 7 para 3 dias. O excedente sai nas
limpezas horárias seguintes; para o arquivo encolher de novo, rodar uma vez depois que `complete = true`:

```sql
VACUUM FULL ANALYZE stock_sync_proposals;
```
