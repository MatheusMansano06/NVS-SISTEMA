import { describe, expect, it } from 'vitest';
import { teamCost, type StaffMember } from './team-cost.js';

const m = (p: Partial<StaffMember>): StaffMember => ({ role: 'clt', regime: 'simples', salario: 4200, vt: 0, vr: 0, saude: 0, outros: 0, ...p });
const line = (r: ReturnType<typeof teamCost>, key: string) => r.lines.find((l) => l.key === key)?.valor;

describe('custo real da equipe', () => {
  it('CLT no Simples: salário + 13º + férias + FGTS + reserva da multa (INSS no DAS)', () => {
    const r = teamCost(m({}));
    expect(line(r, 'decimo')).toBe(350);
    expect(line(r, 'ferias')).toBe(466.67);
    expect(line(r, 'fgts')).toBe(401.33); // 8% de 5016,67
    expect(line(r, 'multa')).toBe(160.53);
    expect(line(r, 'inss')).toBe(0);
    expect(r.total).toBe(5578.53);
    expect(r.multiplicador).toBe(1.33);
  });

  it('CLT no Lucro Presumido paga 27,8% sobre salário, 13º e férias', () => {
    const r = teamCost(m({ regime: 'presumido_real' }));
    expect(line(r, 'inss')).toBe(1394.63);
    expect(r.multiplicador).toBe(1.66);
  });

  it('vale-transporte: a empresa paga só o que passa de 6% do salário', () => {
    expect(line(teamCost(m({ vt: 400 })), 'vt')).toBe(148);
    expect(line(teamCost(m({ vt: 200 })), 'vt')).toBe(0);
  });

  it('aprendiz tem FGTS de 2%; estagiário não tem encargos; PJ é só a nota', () => {
    expect(line(teamCost(m({ role: 'aprendiz' })), 'fgts')).toBe(100.33);
    const est = teamCost(m({ role: 'estagio', salario: 1200, vt: 220, outros: 30 }));
    expect(est.total).toBe(1200 + 100 + 220 + 30);
    expect(teamCost(m({ role: 'pj', salario: 5000 })).total).toBe(5000);
  });

  it('pró-labore: 20% de INSS fora do Simples', () => {
    expect(teamCost(m({ role: 'pro_labore', salario: 3000 })).total).toBe(3000);
    expect(teamCost(m({ role: 'pro_labore', salario: 3000, regime: 'presumido_real' })).total).toBe(3600);
  });
});
