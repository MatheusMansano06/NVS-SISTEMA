import { TEAM_AREAS, TEAM_AREA_LABELS, type TeamMemberInput } from '@nvs/shared';

export const emptyMember = (master = false): TeamMemberInput => ({ name: '', area: master ? 'ambos' : 'operacao', master });

/** Lista editável da equipe: nome, função (Análise/Operação/as duas) e MASTER. */
export function TeamRows({ rows, onChange }: { rows: TeamMemberInput[]; onChange: (rows: TeamMemberInput[]) => void }) {
  const set = (i: number, p: Partial<TeamMemberInput>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="team-rows">
      {rows.map((r, i) => (
        <div key={i} className="team-row">
          <label className="team-name">
            <small>Nome</small>
            <input value={r.name} maxLength={60} placeholder="Ex.: Matheus" onChange={(e) => set(i, { name: e.target.value })} />
          </label>
          <label className="team-area">
            <small>Função</small>
            <select value={r.area} onChange={(e) => set(i, { area: e.target.value as TeamMemberInput['area'] })}>
              {TEAM_AREAS.map((a) => <option key={a} value={a}>{TEAM_AREA_LABELS[a]}</option>)}
            </select>
          </label>
          <label className="team-master" title="MASTER cadastra e edita a equipe">
            <input type="checkbox" checked={r.master} onChange={(e) => set(i, { master: e.target.checked })} />
            MASTER
          </label>
          {rows.length > 1 && (
            <button type="button" className="icon-x" aria-label={`Remover ${r.name || 'pessoa'}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button>
          )}
        </div>
      ))}
      <button type="button" className="link team-add" onClick={() => onChange([...rows, emptyMember()])}>+ Adicionar pessoa</button>
    </div>
  );
}

/** Validação simples antes de enviar (o servidor confere de novo). */
export function teamProblem(rows: TeamMemberInput[]): string | null {
  const filled = rows.filter((r) => r.name.trim());
  if (!filled.length) return 'Cadastre pelo menos uma pessoa.';
  if (!filled.some((r) => r.master)) return 'Marque pelo menos um MASTER.';
  if (new Set(filled.map((r) => r.name.trim().toLowerCase())).size !== filled.length) return 'Há nomes repetidos.';
  return null;
}
