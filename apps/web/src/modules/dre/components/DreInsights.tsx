import { useState } from 'react';
import type { DreDto, DreSectionId } from '@nvs/shared';
import { int, money } from '../../../shared/format';

const total = (d: DreDto, id: DreSectionId) => d.sections.find((s) => s.id === id)?.total ?? 0;

/** "Quanto preciso vender para não ter prejuízo?" — o ponto de equilíbrio em linguagem de gente. */
export function BreakEven({ data, onAddFixed }: { data: DreDto; onAddFixed: () => void }) {
  const fixed = total(data, 'fixas') + total(data, 'financeiras');
  const pe = data.pontoEquilibrio;
  const ticket = data.pedidos ? data.receitaBruta / data.pedidos : 0;
  const progress = pe ? Math.min(1, data.receitaBruta / pe) : 0;
  const falta = pe ? Math.max(0, pe - data.receitaBruta) : 0;
  const diasRestantes = data.isCurrentMonth ? data.daysInMonth - data.elapsedDays + 1 : 0;

  return (
    <section className="panel dre-card" aria-labelledby="be-title">
      <h2 id="be-title">🎯 Quanto preciso vender para empatar?</h2>
      {fixed === 0 ? (
        <>
          <p className="dre-muted">
            Lance suas despesas fixas (aluguel, salários, internet…) e o sistema calcula o mínimo que você precisa vender no mês
            para não ter prejuízo.
          </p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onAddFixed}>+ Lançar despesa fixa</button>
        </>
      ) : !pe ? (
        <p className="dre-alert">
          Neste mês as vendas não deixaram sobra (a margem de contribuição está negativa): vender mais <b>aumenta</b> o prejuízo.
          Reveja preços, custos dos produtos e frete antes de acelerar as vendas.
        </p>
      ) : (
        <>
          <p className="be-value">
            <span className="money">{money(pe)}</span>
            <small>por mês{ticket > 0 && <> · ≈ {int(Math.ceil(pe / ticket))} pedidos</>}</small>
          </p>
          <div className="be-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Quanto do ponto de equilíbrio você já vendeu">
            <span style={{ width: `${progress * 100}%` }} data-done={progress >= 1 || undefined} />
          </div>
          <p className="be-text">
            {falta === 0 ? (
              <>✅ Você já passou do ponto de equilíbrio: o que vender a mais é lucro.</>
            ) : (
              <>
                Faltam <b className="money">{money(falta)}</b>
                {ticket > 0 && <> (≈ {int(Math.ceil(falta / ticket))} pedidos)</>}
                {diasRestantes > 0 && <>, uns <b className="money">{money(falta / diasRestantes)}</b> por dia até o fim do mês</>}.
              </>
            )}
          </p>
          <p className="dre-muted">
            Conta: despesas fixas e financeiras ({money(fixed)}) ÷ quanto sobra de cada real vendido (
            {((data.subtotals.margem_contribuicao / data.receitaBruta) * 100).toFixed(1).replace('.', ',')}%).
          </p>
        </>
      )}
    </section>
  );
}

function Slider({ label, value, set, min, max, hint }: { label: string; value: number; set: (n: number) => void; min: number; max: number; hint: string }) {
  return (
    <label className="wi-slider">
      <span>
        {label} <b data-pos={value > 0 || undefined} data-neg={value < 0 || undefined}>{value > 0 ? '+' : ''}{value}%</b>
      </span>
      <input type="range" min={min} max={max} step={5} value={value} onChange={(e) => set(Number(e.target.value))} />
      <small>{hint}</small>
    </label>
  );
}

/** Simulador "E se…?": mexe nas alavancas do negócio e mostra o efeito no lucro. */
export function WhatIf({ data }: { data: DreDto }) {
  const [vendas, setVendas] = useState(0);
  const [custo, setCusto] = useState(0);
  const [fixas, setFixas] = useState(0);
  const v = 1 + vendas / 100;
  const t = (id: DreSectionId) => total(data, id);
  // o que depende das vendas acompanha o volume; o custo da mercadoria também muda pela negociação
  const margem = (t('receita') - t('deducoes') - t('variaveis')) * v - t('cmv') * (1 + custo / 100) * v;
  const lucro = margem - t('fixas') * (1 + fixas / 100) - t('financeiras');
  const atual = data.subtotals.lucro_liquido;
  const diff = lucro - atual;
  const touched = vendas !== 0 || custo !== 0 || fixas !== 0;


  return (
    <section className="panel dre-card" aria-labelledby="wi-title">
      <div className="dre-card-head">
        <h2 id="wi-title">🧪 E se…?</h2>
        {touched && (
          <button type="button" className="link" onClick={() => { setVendas(0); setCusto(0); setFixas(0); }}>
            zerar
          </button>
        )}
      </div>
      <p className="dre-muted">Arraste e veja o que acontece com o lucro deste mês.</p>
      <Slider label="Vender mais (ou menos)" value={vendas} set={setVendas} min={-50} max={100} hint="Mesmo preço, mais pedidos" />
      <Slider label="Custo dos produtos" value={custo} set={setCusto} min={-30} max={30} hint="Negociar com o fornecedor" />
      <Slider label="Despesas fixas" value={fixas} set={setFixas} min={-50} max={50} hint="Cortar ou aumentar a estrutura" />
      <div className="wi-result" data-neg={lucro < 0 || undefined}>
        <span>Lucro no cenário</span>
        <strong className="money">{money(lucro)}</strong>
        {touched && (
          <small data-pos={diff > 0 || undefined} data-neg={diff < 0 || undefined}>
            {diff >= 0 ? '▲' : '▼'} <span className="money">{money(Math.abs(diff))}</span> em relação ao real
          </small>
        )}
      </div>
    </section>
  );
}
