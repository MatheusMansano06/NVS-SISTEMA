import { useEffect, useState } from 'react';
import type { WmsOverviewDto, WmsRankingDto } from '@nvs/shared';
import { int } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { fullApi } from './full-api';

/** Visão Geral da Supervisão Full (Análise e Operação): andamento das listas, faltas e ranking. */
export function FullOverview({ onShortages, onLists }: { onShortages: () => void; onLists: () => void }) {
  const [data, setData] = useState<WmsOverviewDto | null>(null);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState<Date | null>(null);

  useEffect(() => {
    const load = () =>
      fullApi
        .overview()
        .then((d) => {
          setData(d);
          setUpdated(new Date());
        })
        .catch((err) => setError(err instanceof ApiError ? err.message : 'Não foi possível carregar.'));
    void load();
    // atualiza sozinho a cada minuto (pausa com a aba escondida)
    const t = window.setInterval(() => document.visibilityState === 'visible' && void load(), 60_000);
    return () => window.clearInterval(t);
  }, []);

  if (error) return <p className="banner banner-error" role="alert">{error}</p>;
  if (!data) return <div className="promo-skel" aria-hidden="true" />;
  if (!data.lists.total) {
    return (
      <div className="skus-empty">
        <strong>Nenhuma lista carregada ainda</strong>
        <p>Quem é da Análise carrega o PDF do envio Full em <b>Processamento</b> e as listas aparecem aqui para a Operação.</p>
      </div>
    );
  }
  const { lists, units, shortage } = data;
  const pct = units.total ? Math.round((units.picked / units.total) * 100) : 0;
  const share = (n: number) => (lists.total ? Math.round((n / lists.total) * 100) : 0);
  const impact = units.total ? Math.round((shortage.units / units.total) * 100) : 0;

  return (
    <div className="full-ov">
      <section className="full-hero" aria-label="Painel executivo de expedição">
        <div className="full-hero-top">
          <div>
            <p className="full-kicker">Painel executivo de expedição</p>
            <p className="full-hero-pct">
              <b>{pct}%</b> <span>{int(units.picked)} / {int(units.total)} unidades</span>
            </p>
          </div>
          <div className="full-rate">
            <small>Taxa de conclusão</small>
            <b>{share(lists.completed)}%</b>
          </div>
        </div>
        <div className="full-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <p className="full-hero-foot">
          <span>{updated ? `Atualizado às ${updated.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
          <span>Meta operacional: 100%</span>
        </p>
      </section>

      <section className="full-kpis" aria-label="Resumo">
        <div className="full-kpi full-kpi-dark">
          <small>Volume processado</small>
          <b>{int(units.picked)}</b>
          <span>unidades separadas</span>
        </div>
        <div className="full-kpi">
          <small>Pendentes</small>
          <b>{int(Math.max(0, units.total - units.picked))}</b>
          <span>unidades restantes</span>
        </div>
        <button type="button" className="full-kpi" onClick={onLists}>
          <small>Listas concluídas</small>
          <b>{lists.completed}/{lists.total}</b>
          <span>{share(lists.completed)}% do total →</span>
        </button>
        <div className="full-kpi">
          <small>Média por lista</small>
          <b>{int(lists.total ? units.picked / lists.total : 0)}</b>
          <span>unidades por lista</span>
        </div>
      </section>

      <div className="full-two">
        <section className="full-box" aria-label="Distribuição de status">
          <p className="full-kicker">Distribuição de status</p>
          {[
            { label: 'Em andamento', n: lists.inProgress, tone: 'blue' },
            { label: 'Disponíveis', n: lists.open, tone: 'gray' },
            { label: 'Concluídas', n: lists.completed, tone: 'ok' },
          ].map((r) => (
            <div key={r.label} className="full-dist">
              <p>
                <span>{r.label}</span>
                <b>{r.n} ({share(r.n)}%)</b>
              </p>
              <span className="full-track" data-tone={r.tone}>
                <i style={{ width: `${share(r.n)}%` }} />
              </span>
            </div>
          ))}
        </section>

        <button type="button" className="full-box full-short" onClick={onShortages}>
          <p className="full-kicker">Relatório de faltas <span aria-hidden="true">→</span></p>
          <div className="full-short-nums">
            <div><small>Itens faltantes</small><b>{int(shortage.units)}</b></div>
            <div><small>SKUs com falta</small><b>{shortage.skus}</b></div>
            <div><small>Impacto no volume</small><b>{impact}%</b></div>
          </div>
          <p className="full-short-tip">{shortage.units ? 'Prioridade: revisar faltas antes do fechamento final do lote.' : 'Nenhuma falta registrada. 👏'}</p>
        </button>
      </div>

      <Ranking batches={data.batches.filter((b) => b.status === 'active')} />
    </div>
  );
}

function Ranking({ batches }: { batches: { id: string; name: string }[] }) {
  const [batch, setBatch] = useState<string | undefined>(undefined);
  const [data, setData] = useState<WmsRankingDto | null>(null);
  useEffect(() => {
    setData(null);
    fullApi.ranking(batch).then(setData).catch(() => setData({ operators: [] }));
  }, [batch]);
  const max = Math.max(1, ...(data?.operators.map((o) => o.total) ?? []));
  return (
    <section className="full-box full-rank" aria-label="Performance de operadores">
      <header>
        <h2>Performance de operadores</h2>
        <span className="full-pill">Unidades separadas</span>
      </header>
      <div className="full-chips" role="tablist" aria-label="Lote">
        <button type="button" role="tab" aria-checked={!batch} onClick={() => setBatch(undefined)}>Visão global</button>
        {batches.map((b) => (
          <button key={b.id} type="button" role="tab" aria-checked={batch === b.id} onClick={() => setBatch(b.id)}>📦 {b.name}</button>
        ))}
      </div>
      {!data ? (
        <div className="promo-skel full-rank-skel" aria-hidden="true" />
      ) : !data.operators.length ? (
        <p className="full-empty">Nenhuma unidade separada ainda.</p>
      ) : (
        <ol className="full-rank-list">
          {data.operators.slice(0, 8).map((o, i) => (
            <li key={o.name}>
              <p>
                <span>{i + 1}. {o.name}</span>
                <b>{int(o.total)}</b>
              </p>
              <span className="full-track" data-tone={i === 0 ? 'navy' : 'blue'}>
                <i style={{ width: `${Math.max(6, (o.total / max) * 100)}%` }} />
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
