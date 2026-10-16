import { useEffect, useState } from 'react';
import type { DreDto, DreSectionId } from '@nvs/shared';
import { navigate } from '../../app/router';
import { money } from '../../shared/format';
import { HundredBar } from './components/DreCharts';
import { monthLabel, thisMonth } from './dre-copy';
import { dreApi } from './dre-api';
import './dre.css';

/** Dashboard: resumo do DRE do mês (lucro de verdade, depois das despesas da empresa) com atalho para a tela completa. */
export function DreCard({ accountId, stamp }: { accountId?: string; stamp?: string }) {
  const [data, setData] = useState<DreDto | null>(null);
  const [focus, setFocus] = useState<DreSectionId | 'lucro' | null>(null);
  const month = thisMonth();

  useEffect(() => {
    const c = new AbortController();
    dreApi
      .get(month, { accountId, comparar: false }, c.signal)
      .then(setData)
      .catch(() => undefined);
    return () => c.abort();
  }, [month, accountId, stamp]);

  if (!data) return null;
  const lucro = data.subtotals.lucro_liquido;
  const pe = data.pontoEquilibrio;
  return (
    <section
      className="panel dre-card-mini"
      data-neg={lucro < 0 || undefined}
      aria-labelledby="dre-mini-title"
    >
      <div>
        <p className="mini-label" id="dre-mini-title">
          Lucro de {monthLabel(month).split(' ')[0]!.toLowerCase()} (DRE)
        </p>
        <p className="mini-value money">{money(lucro)}</p>
        {data.projecao && (
          <p className="mini-label">
            no ritmo atual: <b className="money">{money(data.projecao.lucroLiquido)}</b>
          </p>
        )}
      </div>
      <div className="mini-mid">
        <HundredBar data={data} focus={focus} onFocus={setFocus} compact />
        <p>
          {data.lancamentos === 0 ? (
            <>
              Ainda sem aluguel, salários e outros gastos da empresa: o lucro real é menor que este.
            </>
          ) : pe ? (
            data.receitaBruta >= pe ? (
              <>✅ Já passou do ponto de equilíbrio ({money(pe)}).</>
            ) : (
              <>
                Faltam <b className="money">{money(pe - data.receitaBruta)}</b> em vendas para
                empatar o mês.
              </>
            )
          ) : (
            <>
              De cada R$ 100 vendidos, {lucro >= 0 ? 'sobram' : 'faltam'} R${' '}
              {Math.abs(data.receitaBruta ? (lucro / data.receitaBruta) * 100 : 0)
                .toFixed(2)
                .replace('.', ',')}
              .
            </>
          )}
        </p>
      </div>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/dre')}>
        {data.lancamentos === 0 ? 'Lançar gastos →' : 'Ver DRE →'}
      </button>
    </section>
  );
}
