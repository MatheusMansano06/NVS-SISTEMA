import type { DreBasis, DreCategory, DreKind, DreSectionId, DreSubtotalId, TeamRole } from '@nvs/shared';

/** Cada linha do DRE em linguagem do dia a dia, com o nome técnico ao lado (para quem quer aprender). */
export interface Copy {
  label: string;
  tecnico: string;
  explain: string;
  exemplo?: string;
}

export const SECTION_COPY: Record<DreSectionId, Copy & { emoji: string; curto: string }> = {
  receita: {
    curto: 'Vendeu',
    emoji: '🛒',
    label: 'Você vendeu',
    tecnico: 'Receita bruta',
    explain: 'Tudo o que os clientes pagaram pelos seus produtos no mês. Pedidos cancelados não entram. Esse dinheiro ainda não é seu: daqui para baixo saem impostos, custos e despesas.',
  },
  deducoes: {
    curto: 'Impostos',
    emoji: '🧾',
    label: 'Impostos e descontos da venda',
    tecnico: 'Deduções da receita',
    explain: 'Dinheiro que nunca foi seu: os impostos que incidem sobre cada venda (Simples Nacional, por exemplo), o DIFAL que o Mercado Livre cobra, os cupons que você bancou e as devoluções parciais.',
    exemplo: 'Vendeu R$ 100 com 10% de imposto: R$ 10 já são do governo.',
  },
  cmv: {
    curto: 'Mercadoria',
    emoji: '📦',
    label: 'Custo das mercadorias',
    tecnico: 'CMV — custo da mercadoria vendida',
    explain: 'Quanto você pagou ao fornecedor pelos produtos que saíram neste mês. Vem do Cadastro de SKUs. Só conta o que foi vendido: o que ainda está parado no estoque não entra aqui.',
    exemplo: 'Comprou 100 peças, vendeu 30: só as 30 entram no mês.',
  },
  variaveis: {
    curto: 'Para vender',
    emoji: '🚚',
    label: 'Custos para vender',
    tecnico: 'Custos variáveis',
    explain: 'Gastos que aumentam junto com as vendas: tarifa do Mercado Livre, frete, anúncios, embalagem, etiqueta, motoboy. Vendeu o dobro, gasta (mais ou menos) o dobro. Se não vender nada, eles quase somem.',
    exemplo: 'Cada pedido usa uma caixa de R$ 1,20: 1.000 pedidos = R$ 1.200.',
  },
  fixas: {
    curto: 'Estrutura',
    emoji: '🏢',
    label: 'Custos para a empresa existir',
    tecnico: 'Despesas fixas (operacionais)',
    explain: 'Você paga todo mês, vendendo muito ou nada: aluguel, salários, pró-labore, internet, luz, água, contador, sistemas. São elas que o lucro das vendas precisa cobrir.',
    exemplo: 'O aluguel é o mesmo se você vender 10 ou 10.000 pedidos.',
  },
  financeiras: {
    curto: 'Juros',
    emoji: '🏦',
    label: 'Bancos e juros',
    tecnico: 'Despesas financeiras',
    explain: 'O custo do dinheiro: juros de empréstimo, antecipação de recebíveis, tarifas bancárias. Não têm a ver com vender, e sim com como a empresa se financia.',
  },
};

export const SUBTOTAL_COPY: Record<DreSubtotalId, Copy> = {
  receita_liquida: {
    label: 'Ficou das vendas',
    tecnico: 'Receita líquida',
    explain: 'O que é de fato da empresa depois de impostos e descontos. É daqui que tudo será pago.',
  },
  lucro_bruto: {
    label: 'Sobrou depois da mercadoria',
    tecnico: 'Lucro bruto',
    explain: 'Quanto sobra depois de pagar os produtos. Ainda faltam o marketplace, o frete e a operação.',
  },
  margem_contribuicao: {
    label: 'Sobra das vendas',
    tecnico: 'Margem de contribuição',
    explain: 'O dinheiro que as vendas geram para pagar a estrutura (aluguel, salários…). É o número mais importante de quem vende online: se ele for negativo, cada venda dá prejuízo e vender mais só piora.',
  },
  lucro_operacional: {
    label: 'Resultado da operação',
    tecnico: 'Lucro operacional',
    explain: 'Quanto a operação da loja gerou no mês, depois de pagar tudo o que é do dia a dia. Ainda faltam os bancos e juros.',
  },
  lucro_liquido: {
    label: 'Sobrou no bolso',
    tecnico: 'Lucro líquido',
    explain: 'O resultado final do mês: o que a empresa realmente ganhou (ou perdeu) depois de pagar absolutamente tudo.',
  },
};

/** Onde cada tipo de lançamento aparece no DRE. */
export const KIND_SECTION: Record<DreKind, DreSectionId> = {
  custo_variavel: 'variaveis',
  despesa_fixa: 'fixas',
  despesa_financeira: 'financeiras',
};

export interface Template {
  name: string;
  emoji: string;
  kind: DreKind;
  category: DreCategory;
  basis: DreBasis;
  dica?: string;
  /** pessoa da equipe: abre a calculadora de custo real */
  pessoa?: TeamRole;
}

/** Gastos comuns de quem vende online, já classificados: a pessoa só informa o valor. */
export const TEMPLATES: Template[] = [
  { name: 'Aluguel', emoji: '🏠', kind: 'despesa_fixa', category: 'estrutura', basis: 'mensal' },
  { name: 'Energia elétrica', emoji: '💡', kind: 'despesa_fixa', category: 'estrutura', basis: 'mensal', dica: 'Use a média das últimas contas.' },
  { name: 'Água', emoji: '🚿', kind: 'despesa_fixa', category: 'estrutura', basis: 'mensal' },
  { name: 'Internet', emoji: '📶', kind: 'despesa_fixa', category: 'estrutura', basis: 'mensal' },
  { name: 'Telefone / celular', emoji: '📱', kind: 'despesa_fixa', category: 'estrutura', basis: 'mensal' },
  { name: 'Funcionário', emoji: '👥', kind: 'despesa_fixa', category: 'pessoas', basis: 'mensal', pessoa: 'clt' },
  { name: 'Pró-labore (seu salário)', emoji: '🧑‍💼', kind: 'despesa_fixa', category: 'pessoas', basis: 'mensal', pessoa: 'pro_labore' },
  { name: 'Contador', emoji: '📊', kind: 'despesa_fixa', category: 'servicos', basis: 'mensal' },
  { name: 'Sistema / ERP', emoji: '💻', kind: 'despesa_fixa', category: 'sistemas', basis: 'mensal' },
  { name: 'Apps e assinaturas', emoji: '🧩', kind: 'despesa_fixa', category: 'sistemas', basis: 'mensal', dica: 'Canva, ChatGPT, editor de fotos…' },
  { name: 'Limpeza e manutenção', emoji: '🧹', kind: 'despesa_fixa', category: 'estrutura', basis: 'mensal' },
  { name: 'Marketing fora do ML', emoji: '📣', kind: 'despesa_fixa', category: 'marketing', basis: 'mensal', dica: 'Instagram, influenciadores, fotos de produto.' },
  { name: 'Embalagens', emoji: '📦', kind: 'custo_variavel', category: 'logistica', basis: 'pedido', dica: 'Caixa, envelope, plástico bolha: quanto gasta, em média, por pedido.' },
  { name: 'Etiquetas e fita', emoji: '🏷️', kind: 'custo_variavel', category: 'logistica', basis: 'pedido' },
  { name: 'Motoboy / entregas Flex', emoji: '🛵', kind: 'custo_variavel', category: 'logistica', basis: 'pedido' },
  { name: 'Frete para enviar ao Full', emoji: '🚛', kind: 'custo_variavel', category: 'logistica', basis: 'mensal' },
  { name: 'Comissão de vendedor', emoji: '🤝', kind: 'custo_variavel', category: 'pessoas', basis: 'percentual' },
  { name: 'Juros de empréstimo', emoji: '🏦', kind: 'despesa_financeira', category: 'financeiro', basis: 'mensal', dica: 'Só os juros. A parte que devolve o dinheiro emprestado não é despesa.' },
  { name: 'Antecipação de recebíveis', emoji: '💸', kind: 'despesa_financeira', category: 'financeiro', basis: 'percentual', dica: 'A taxa que você paga para receber antes.' },
  { name: 'Tarifas bancárias', emoji: '💳', kind: 'despesa_financeira', category: 'financeiro', basis: 'mensal' },
];

export const KIND_HELP: Record<DreKind, { titulo: string; frase: string; exemplos: string }> = {
  custo_variavel: {
    titulo: 'Custo variável',
    frase: 'Cresce quando você vende mais.',
    exemplos: 'Embalagem, etiqueta, motoboy, comissão',
  },
  despesa_fixa: {
    titulo: 'Despesa fixa',
    frase: 'Você paga mesmo sem vender.',
    exemplos: 'Aluguel, salários, internet, contador',
  },
  despesa_financeira: {
    titulo: 'Despesa financeira',
    frase: 'É o custo do dinheiro.',
    exemplos: 'Juros, antecipação, tarifa do banco',
  },
};

/** Mês AAAA-MM no fuso local. */
export const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
export const shiftMonth = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
export const monthLabel = (month: string, short = false) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const s = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', short ? { month: 'short', year: '2-digit' } : { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
};
