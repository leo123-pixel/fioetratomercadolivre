-- stock_sync_jobs.proposal_id referencia stock_sync_proposals com ON DELETE SET NULL. Sem índice, cada proposta
-- apagada pela retenção do histórico (src/lib/maintenance/retention.ts) varria stock_sync_jobs inteira: em produção
-- (27/11/2026) um lote de 10 mil consumia os 20 s da limpeza por tick. A tabela é pequena: criação instantânea.
CREATE INDEX IF NOT EXISTS "stock_sync_jobs_proposal_idx" ON "stock_sync_jobs" ("proposal_id");
