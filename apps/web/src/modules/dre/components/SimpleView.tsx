import { useState } from 'react';
import type { DreDto, DreSectionId } from '@nvs/shared';
import { int, money } from '../../../shared/format';
import { SECTION_COPY } from '../dre-copy';
import { MlReconcile } from './MlReconcile';

/** Nome curto e exemplos do que entra em cada bloco, para quem nunca viu um DRE. */
const SIMPLE: Record<DreSectionId, { label: string; ex: string }> = {
  receita: { label: 'Você vendeu', ex: '' },
  deducoes: { label: 'Impostos e descontos', ex: 'imposto da nota, cupons, devoluções' },
  cmv: { label: 'Mercadoria', ex: 'o que você pagou ao fornecedor pelo que vendeu' },
  variaveis: { label: 'Para vender', ex: 'tarifa do Mercado Livre, frete, anúncios, embalagem' },
  fixas: { label: 'Para a empresa funcionar', ex: 'equipe, aluguel, internet, contador' },
  financeiras: { label: 'Bancos e juros', ex: 'juros e tarifas do banco' },
};
const COSTS: DreSectionId[] = ['deducoes', 'cmv', 'variaveis', 'fixas', 'financeiras'];

/** Resumo para leigos: um "cupom" do mês (vendeu → saiu → sobrou) e uma única dica do que fazer. */
export function SimpleView({ data, onSetup }: { data: DreDto; onSetup: () => void }) {
  const [open, setOpen] = useState<DreSectionId | null>(null);
  const base = data.receitaBruta;
  const lucro = data.subtotals.lucro_liquido;
  const sec = (id: DreSectionId) => data.sections.find((s) => s.id === id)!;
  const per100 = (v: number) => (base > 0 ? (v / base) * 100 : 0);
  const rows = COSTS.filter(
    (id) => sec(id).total > 0 || (id === 'fixas' && data.lancamentos === 0),
  );

  return (
    <>
      <section className="panel receipt" aria-labelledby="rc-title">
        <h2 id="rc-title">Para onde foi o dinheiro</h2>
        <div className="rc-row rc-in" data-sec="receita">
          <span className="rc-label">
            🛒 {SIMPLE.receita.label}
            <small>{int(data.pedidos)} pedidos</small>
          </span>
          <b className="money">{money(base)}</b>
        </div>
        <MlReconcile data={data} />
        {rows.map((id) => {
          const s = sec(id);
          const empty = s.total === 0;
          return (
            <div key={id} className="rc-block" data-sec={id}>
              <button
                type="button"
                className="rc-row"
                aria-expanded={open === id}
                disabled={empty}
                onClick={() => setOpen(open === id ? null : id)}
              >
                <span className="rc-label">
                  <span>
                    <span aria-hidden="true">{SECTION_COPY[id].emoji}</span> {SIMPLE[id].label}
                  </span>
                  <small>{SIMPLE[id].ex}</small>
                </span>
                {empty ? (
                  <span className="rc-missing">não cadastrado</span>
                ) : (
                  <>
                    <span className="rc-bar" aria-hidden="true">
                      <i style={{ width: `${Math.min(100, per100(s.total))}%` }} />
                    </span>
                    <b className="money">− {money(s.total)}</b>
                  </>
                )}
              </button>
              {empty && (
                <button type="button" className="link rc-add" onClick={onSetup}>
                  Cadastrar equipe, aluguel e outros gastos →
                </button>
              )}
              {open === id && (
                <ul className="rc-items">
                  {s.items.map((it) => (
                    <li key={it.key}>
                      <span>{it.label}</span>
                      <span className="money">{money(it.valor)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        <div className="rc-row rc-out" data-neg={lucro < 0 || undefined}>
          <span className="rc-label">
            {lucro >= 0 ? '💰 Sobrou para você' : '⚠️ Faltou (prejuízo)'}
          </span>
          <b className="money">{money(lucro)}</b>
        </div>
      </section>
      <Insight data={data} onSetup={onSetup} />
    </>
  );
}

/** Uma dica só, a mais importante para o momento da loja. */
function Insight({ data, onSetup }: { data: DreDto; onSetup: () => void }) {
  const lucro = data.subtotals.lucro_liquido;
  const pe = data.pontoEquilibrio;
  const ticket = data.pedidos ? data.receitaBruta / data.pedidos : 0;
  const pedidos = (v: number) => (ticket > 0 ? ` (≈ ${int(Math.ceil(v / ticket))} pedidos)` : '');

  let tone: 'ok' | 'warn' | 'bad' = 'ok';
  let title: string;
  let text: string;
  let progress: number | null = null;
  if (data.receitaBruta <= 0) {
    title = 'Ainda sem vendas neste mês';
    text = 'Assim que as vendas entrarem, o resultado aparece aqui.';
  } else if (data.subtotals.margem_contribuicao < 0) {
    tone = 'bad';
    title = 'As vendas estão dando prejuízo';
    text =
      'Mesmo antes dos custos da empresa, o que entra não paga a mercadoria, o Mercado Livre e o frete. Vender mais aumenta o prejuízo: revise preços, custo dos produtos e frete.';
  } else if (data.lancamentos === 0) {
    tone = 'warn';
    title = 'Esse lucro ainda não é real';
    text =
      'Faltam os custos da empresa (equipe, aluguel, internet…). Cadastre uma vez e eles entram sozinhos todo mês.';
  } else if (pe && data.receitaBruta < pe) {
    tone = lucro < 0 ? 'bad' : 'warn';
    progress = data.receitaBruta / pe;
    title = `Para não ter prejuízo, venda ${money(pe)} no mês`;
    text = `Faltam ${money(pe - data.receitaBruta)}${pedidos(pe - data.receitaBruta)}. Esse é o valor que paga todos os custos da empresa.`;
  } else {
    progress = 1;
    title = 'Você já pagou as contas do mês';
    text = pe
      ? `A partir de ${money(pe)} em vendas, o que entra vira lucro. Daqui pra frente, cada venda engorda o resultado.`
      : 'Siga assim!';
  }

  return (
    <section className="panel insight" data-tone={tone} aria-label="O que isso quer dizer">
      <p className="insight-kicker">O que isso quer dizer</p>
      <h2>{title}</h2>
      <p>{text}</p>
      {progress !== null && (
        <div
          className="be-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          aria-label="Quanto já foi vendido do necessário"
        >
          <span
            style={{ width: `${Math.min(1, progress) * 100}%` }}
            data-done={progress >= 1 || undefined}
          />
        </div>
      )}
      {data.lancamentos === 0 && data.receitaBruta > 0 && (
        <button type="button" className="btn btn-primary btn-sm" onClick={onSetup}>
          Cadastrar meus custos
        </button>
      )}
    </section>
  );
}
