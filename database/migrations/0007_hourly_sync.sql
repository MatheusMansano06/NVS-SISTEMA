-- Atualização automática de hora em hora (incremental), além da sincronização completa inicial.
ALTER TABLE ml_sync_runs ADD COLUMN kind text NOT NULL DEFAULT 'full' CHECK (kind IN ('full', 'incremental'));

-- Garante que, com várias instâncias da API, cada hora seja processada uma única vez.
CREATE TABLE scheduler_ticks (
  job        text NOT NULL,
  slot       timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job, slot)
);
