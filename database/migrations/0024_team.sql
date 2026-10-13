-- Equipe: cada pessoa entra por nome + PIN na Análise, na Operação ou nas duas; MASTER cadastra a equipe.
-- O PIN padrão (1234) deixa de ser troca obrigatória: a pessoa troca se quiser.
ALTER TABLE operators ADD COLUMN area text NOT NULL DEFAULT 'operacao' CHECK (area IN ('analise', 'operacao', 'ambos'));
ALTER TABLE operators ADD COLUMN is_master boolean NOT NULL DEFAULT false;
