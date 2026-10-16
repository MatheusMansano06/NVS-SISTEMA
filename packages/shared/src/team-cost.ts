import { z } from 'zod';

/**
 * Custo real de uma pessoa da equipe (DRE gerencial): o salário da carteira não é o que ela custa.
 * Valores mensais, já provisionando 13º, férias e a multa do FGTS. Alíquotas de referência; o contador confirma as da empresa.
 */
export const TEAM_ROLES = ['clt', 'aprendiz', 'estagio', 'pj', 'pro_labore'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const TEAM_ROLE_INFO: Record<TeamRole, { label: string; curto: string; explain: string; salarioLabel: string }> = {
  clt: {
    label: 'CLT (carteira assinada)',
    curto: 'CLT',
    explain: 'Tem 13º, férias com 1/3, FGTS e, dependendo do regime da empresa, INSS patronal. Por isso custa bem mais que o salário.',
    salarioLabel: 'Salário bruto (o da carteira)',
  },
  aprendiz: {
    label: 'Jovem aprendiz',
    curto: 'Aprendiz',
    explain: 'Como o CLT, mas o FGTS é de 2% em vez de 8%.',
    salarioLabel: 'Salário bruto',
  },
  estagio: {
    label: 'Estagiário',
    curto: 'Estágio',
    explain: 'Não tem FGTS, INSS nem 13º. Tem recesso remunerado (30 dias por ano), seguro obrigatório e vale-transporte.',
    salarioLabel: 'Bolsa-estágio',
  },
  pj: {
    label: 'PJ / freelancer / MEI',
    curto: 'PJ',
    explain: 'Você paga a nota e pronto: sem encargos. Atenção: se tem horário, chefe e exclusividade, a Justiça pode entender como CLT.',
    salarioLabel: 'Valor da nota por mês',
  },
  pro_labore: {
    label: 'Pró-labore (sócio)',
    curto: 'Pró-labore',
    explain: 'O "salário" do dono. Sem FGTS, 13º ou férias. Fora do Simples (e no Anexo IV) a empresa paga 20% de INSS sobre ele.',
    salarioLabel: 'Valor do pró-labore',
  },
};

export const COMPANY_REGIMES = ['simples', 'simples_iv', 'presumido_real'] as const;
export type CompanyRegime = (typeof COMPANY_REGIMES)[number];
export const COMPANY_REGIME_INFO: Record<CompanyRegime, { label: string; explain: string }> = {
  simples: {
    label: 'Simples Nacional',
    explain: 'A maioria das lojas online (comércio, Anexo I). O INSS da empresa já vem dentro do DAS: não há 20% a mais sobre a folha.',
  },
  simples_iv: {
    label: 'Simples — Anexo IV',
    explain: 'Alguns serviços (limpeza, obras, advocacia…). Mesmo no Simples, paga 20% de INSS + RAT sobre a folha à parte.',
  },
  presumido_real: {
    label: 'Lucro Presumido ou Real',
    explain: 'Paga INSS patronal (20%), RAT (≈2%) e terceiros/Sistema S (≈5,8%) sobre a folha: ≈27,8% a mais.',
  },
};

export const RATES = {
  fgts: 0.08,
  fgtsAprendiz: 0.02,
  multaFgts: 0.4,
  inssPatronal: 0.2,
  rat: 0.02,
  terceiros: 0.058,
  descontoVt: 0.06,
} as const;

const money = z.coerce.number().finite().min(0).max(1_000_000);
export const staffCostSchema = z.object({
  role: z.enum(TEAM_ROLES),
  regime: z.enum(COMPANY_REGIMES),
  salario: money,
  /** vale-transporte: quanto custam as passagens do mês (o funcionário CLT banca até 6% do salário) */
  vt: money.default(0),
  /** vale-refeição / alimentação pago pela empresa */
  vr: money.default(0),
  saude: money.default(0),
  /** uniforme, seguro do estágio, cursos, EPI… */
  outros: money.default(0),
});
export type StaffMember = z.infer<typeof staffCostSchema>;

export interface TeamCostLine {
  key: string;
  label: string;
  valor: number;
  explain: string;
  /** linha que não pesa neste regime, mostrada para ensinar o porquê */
  zeroReason?: string;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function teamCost(m: StaffMember): { lines: TeamCostLine[]; total: number; multiplicador: number } {
  const s = m.salario;
  const lines: TeamCostLine[] = [];
  const add = (key: string, label: string, valor: number, explain: string, zeroReason?: string) =>
    lines.push({ key, label, valor: r2(valor), explain, ...(zeroReason ? { zeroReason } : {}) });
  const clt = m.role === 'clt' || m.role === 'aprendiz';

  add('base', TEAM_ROLE_INFO[m.role].salarioLabel, s,
    m.role === 'pj' ? 'O valor combinado com o prestador.' : 'O valor de referência. O que a pessoa recebe na conta é menor (ela paga o INSS e o IR dela), mas isso não muda o seu custo.');

  if (clt) {
    const decimo = s / 12;
    const ferias = (s / 12) * (4 / 3);
    const base = s + decimo + ferias;
    const fgtsRate = m.role === 'aprendiz' ? RATES.fgtsAprendiz : RATES.fgts;
    const fgts = base * fgtsRate;
    add('decimo', '13º salário', decimo, 'Um salário a mais por ano. Dividido por 12, é o que você precisa guardar todo mês para pagar em dezembro.');
    add('ferias', 'Férias + 1/3', ferias, 'A cada 12 meses a pessoa tira 30 dias pagos e ganha 1/3 a mais. Guardar 1/12 disso por mês evita susto.');
    add('fgts', `FGTS (${fgtsRate * 100}%)`, fgts, `Depósito mensal de ${fgtsRate * 100}% sobre salário, 13º e férias, numa conta no nome da pessoa.`);
    add('multa', 'Reserva para demissão', fgts * RATES.multaFgts, 'Se demitir sem justa causa, paga multa de 40% sobre todo o FGTS depositado. Quem guarda um pouco por mês não quebra o caixa.');
    if (m.regime === 'presumido_real') {
      const rate = RATES.inssPatronal + RATES.rat + RATES.terceiros;
      add('inss', 'INSS da empresa + RAT + terceiros (27,8%)', base * rate, '20% de INSS patronal, ≈2% de RAT (risco de acidente) e ≈5,8% de terceiros (Sistema S, salário-educação), sobre salário, 13º e férias.');
    } else if (m.regime === 'simples_iv') {
      add('inss', 'INSS da empresa + RAT (22%)', base * (RATES.inssPatronal + RATES.rat), 'No Anexo IV do Simples, o INSS patronal e o RAT são pagos à parte, sobre salário, 13º e férias.');
    } else {
      add('inss', 'INSS da empresa', 0, 'No Simples Nacional (Anexos I, II, III e V) a contribuição da empresa já vem dentro do DAS.', 'já pago no DAS');
    }
    add('vt', 'Vale-transporte (parte da empresa)', Math.max(0, m.vt - s * RATES.descontoVt),
      'A empresa pode descontar até 6% do salário; o que passar disso é custo seu.', m.vt === 0 ? 'não informado' : undefined);
  } else if (m.role === 'estagio') {
    add('recesso', 'Recesso remunerado', s / 12, 'A cada 12 meses de estágio, 30 dias de descanso com bolsa. Guardar 1/12 por mês.');
    add('vt', 'Auxílio-transporte', m.vt, 'Obrigatório para estagiário, pago integralmente pela empresa.', m.vt === 0 ? 'não informado' : undefined);
  } else if (m.role === 'pro_labore') {
    const inss = m.regime === 'simples' ? 0 : s * RATES.inssPatronal;
    add('inss', 'INSS da empresa (20%)', inss,
      m.regime === 'simples' ? 'No Simples (Anexos I, II, III e V) já vem dentro do DAS.' : 'A empresa paga 20% sobre o pró-labore. Os 11% do sócio saem do valor dele, não são custo seu.',
      m.regime === 'simples' ? 'já pago no DAS' : undefined);
  }
  if (m.role !== 'pj' || m.vr > 0) add('vr', 'Vale-refeição / alimentação', m.vr, 'O que a empresa paga de VR/VA no mês.', m.vr === 0 ? 'não informado' : undefined);
  if (m.saude > 0) add('saude', 'Plano de saúde', m.saude, 'A parte da mensalidade que a empresa paga.');
  if (m.outros > 0) add('outros', m.role === 'estagio' ? 'Seguro e outros' : 'Outros (uniforme, cursos, EPI…)', m.outros, 'Outros gastos mensais com a pessoa.');

  const total = r2(lines.reduce((a, l) => a + l.valor, 0));
  return { lines, total, multiplicador: s > 0 ? Math.round((total / s) * 100) / 100 : 0 };
}
