import { useCallback, useEffect, useRef, useState } from 'react';
import type { DreDto, DreEntryDto, DreKind, DreSectionId, MlStatusDto } from '@nvs/shared';
import { AppShell } from '../../app/AppShell';
import { navigate } from '../../app/router';
import { int, money } from '../../shared/format';
import { Icon } from '../../shared/ui/Icon';
import { Modal } from '../../shared/ui/Modal';
import { mlApi } from '../mercado-livre/ml-api';
import { useCountUp } from '../dashboard/useCountUp';
import { useGuidedTour } from '../../shared/tour/Tour';
import { TOURS } from '../../shared/tour/tours';
import { Waterfall } from './components/DreCharts';
import { SimpleView } from './components/SimpleView';
import { BreakEven, WhatIf } from './components/DreInsights';
import { DreStatement } from './components/DreStatement';
import { EntriesList } from './components/EntriesList';
import { EntryWizard } from './components/EntryWizard';
import { CostSetup } from './components/CostSetup';
import { KIND_HELP, monthLabel, shiftMonth, thisMonth, type Template } from './dre-copy';
import { dreApi } from './dre-api';
import '../dashboard/dashboard.css';
import './dre.css';

const TEC_KEY = 'nvs.dre.tecnico';
const VIEW_KEY = 'nvs.dre.view';
type View = 'simples' | 'completo';
const readView = (): View => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'completo' ? 'completo' : 'simples';
  } catch {
    return 'simples';
  }
};
const readTec = () => {
  try {
    return localStorage.getItem(TEC_KEY) === '1';
  } catch {
    return false;
  }
};
type Focus = DreSectionId | 'lucro' | null;
type Wizard = { entry?: DreEntryDto; kind?: DreKind; template?: Template } | null;

/** DRE simplificado: do que você vendeu até o que sobrou no bolso, sem economês. */
export function DrePage() {
  const [month, setMonth] = useState(thisMonth);
  const [accountId, setAccountId] = useState('');
  const [accounts, setAccounts] = useState<MlStatusDto['connections']>([]);
  const [estimar, setEstimar] = useState(true);
  const [tecnico, setTecnico] = useState(readTec);
  const [view, setView] = useState<View>(readView);
  const [data, setData] = useState<DreDto | null>(null);
  const [entries, setEntries] = useState<DreEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [focus, setFocus] = useState<Focus>(null);
  const [open, setOpen] = useState<Set<DreSectionId>>(() => new Set(['variaveis', 'fixas']));
  const [wizard, setWizard] = useState<Wizard>(null);
  const [manage, setManage] = useState(false);
  const [setup, setSetup] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    mlApi
      .status()
      .then((s) => setAccounts(s.connections))
      .catch(() => undefined);
  }, []);

  const load = useCallback(
    async (fresh = false) => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      setLoading(true);
      setError('');
      try {
        const [d, e] = await Promise.all([
          dreApi.get(
            month,
            { accountId: accountId || undefined, estimarCusto: estimar, fresh },
            c.signal,
          ),
          dreApi.entries(),
        ]);
        setData(d);
        setEntries(e);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setError('Não foi possível carregar o DRE.');
      } finally {
        if (ctrl.current === c) setLoading(false);
      }
    },
    [month, accountId, estimar],
  );
  useEffect(() => void load(), [load]);

  const pickView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* vale só nesta sessão */
    }
  };
  const toggleTec = () =>
    setTecnico((v) => {
      try {
        localStorage.setItem(TEC_KEY, v ? '0' : '1');
      } catch {
        /* vale só nesta sessão */
      }
      return !v;
    });
  const toggle = (id: DreSectionId) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const pick = (id: DreSectionId | 'lucro') => {
    const target = id === 'lucro' ? 'dre-statement' : `dre-${id}`;
    if (id !== 'lucro') setOpen((s) => new Set(s).add(id));
    window.setTimeout(
      () =>
        document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
      30,
    );
  };
  const saved = () => {
    setWizard(null);
    void load();
  };

  const now = thisMonth();
  const lucro = data?.subtotals.lucro_liquido ?? 0;
  const lucroShown = useCountUp(lucro);
  const tour = useGuidedTour('dre', TOURS.dre, Boolean(data) && !loading && view === 'simples');
  const diff = data?.previous ? lucro - data.previous.lucroLiquido : null;
  const outras = data?.sections.find((s) => s.id === 'outras')?.total ?? 0;
  // "de cada R$ 100 vendidos" é só do Mercado Livre; a sobra de outras plataformas aparece à parte
  const per100 = data && data.receitaBruta > 0 ? ((lucro - outras) / data.receitaBruta) * 100 : 0;

  return (
    <AppShell>
      <div className="dre" data-loading={loading || undefined}>
        <header className="dre-top">
          <div>
            <p className="dash-kicker">Financeiro</p>
            <h1>Resultado do mês</h1>
          </div>
          <div className="view-switch" role="tablist" aria-label="Modo de visualização">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'simples'}
              onClick={() => pickView('simples')}
            >
              Resumo
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'completo'}
              onClick={() => pickView('completo')}
            >
              DRE completo
            </button>
          </div>
        </header>

        <div className="dre-toolbar" role="toolbar" aria-label="Mês e opções">
          <div className="month-nav">
            <button
              type="button"
              className="icon-btn"
              aria-label="Mês anterior"
              onClick={() => setMonth((m) => shiftMonth(m, -1))}
            >
              <span aria-hidden="true">‹</span>
            </button>
            <strong aria-live="polite">{monthLabel(month)}</strong>
            <button
              type="button"
              className="icon-btn"
              aria-label="Próximo mês"
              disabled={month >= now}
              onClick={() => setMonth((m) => shiftMonth(m, 1))}
            >
              <span aria-hidden="true">›</span>
            </button>
            {month !== now && (
              <button type="button" className="link" onClick={() => setMonth(now)}>
                mês atual
              </button>
            )}
          </div>
          <div className="dre-opts">
            {accounts.length > 1 && (
              <label className="select">
                <span className="sr-only">Conta</span>
                <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  <option value="">Todas as contas</option>
                  {accounts.map((a) => (
                    <option key={a.accountId} value={a.accountId}>
                      {a.nickname}
                    </option>
                  ))}
                </select>
                <Icon name="chevron" size={16} />
              </label>
            )}
            {view === 'completo' && (
              <>
                <label
                  className="ads-toggle"
                  title="Mostra, ao lado de cada linha, o nome que o contador usa"
                >
                  <input type="checkbox" checked={tecnico} onChange={toggleTec} />
                  <span className="ads-switch" aria-hidden="true" />
                  Nomes do contador
                </label>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setManage(true)}
                >
                  Lançamentos{entries.length ? ` (${entries.length})` : ''}
                </button>
              </>
            )}
            <button
              type="button"
              className={`btn btn-sm dre-costs-btn ${data?.lancamentos === 0 ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setSetup(true)}
            >
              Meus custos
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => void load(true)}
              aria-label="Atualizar"
              data-spinning={loading || undefined}
            >
              <Icon name="refresh" />
            </button>
          </div>
        </div>

        {error && (
          <p className="banner banner-error" role="alert">
            {error}
          </p>
        )}

        {!data ? (
          <div className="dre-hero skeleton" aria-busy="true" />
        ) : (
          <>
            <section
              className="dre-hero"
              data-neg={lucro < 0 || undefined}
              aria-label="Resultado do mês"
            >
              <p className="hero-kicker">
                {monthLabel(month)}
                {data.isCurrentMonth && ` · até o dia ${data.elapsedDays}`}
              </p>
              <p className="hero-value">
                <span>{lucro >= 0 ? 'Sobrou' : 'Faltou'}</span>{' '}
                <span className="money">{money(Math.abs(lucroShown))}</span>
              </p>
              {data.receitaBruta > 0 && (
                <p className="hero-story">
                  De cada <b>R$ 100</b> vendidos,{' '}
                  <b className="money">
                    R${' '}
                    {Math.abs(per100).toLocaleString('pt-BR', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </b>{' '}
                  {lucro - outras >= 0 ? 'ficaram com você' : 'faltaram para pagar as contas'}
                  {outras > 0 ? (
                    <>
                      {' '}
                      no Mercado Livre, mais <b className="money">{money(outras)}</b> que sobraram
                      de outras plataformas.
                    </>
                  ) : (
                    '.'
                  )}
                </p>
              )}
              {(diff !== null || data.projecao) && (
                <p className="hero-foot">
                  {diff !== null && data.previous && (
                    <span data-pos={diff > 0 || undefined} data-neg={diff < 0 || undefined}>
                      {diff >= 0 ? '▲' : '▼'} <span className="money">{money(Math.abs(diff))}</span>{' '}
                      {diff >= 0 ? 'a mais' : 'a menos'} que em{' '}
                      {monthLabel(data.previous.month).split(' ')[0]!.toLowerCase()}
                    </span>
                  )}
                  {data.projecao && (
                    <span title="Se as vendas seguirem no ritmo de até hoje; os custos fixos já contam o mês inteiro">
                      No ritmo atual, fecha o mês em{' '}
                      <b className="money">{money(data.projecao.lucroLiquido)}</b>
                    </span>
                  )}
                </p>
              )}
            </section>

            {data.cobertura.semCustoQtd > 0 && (
              <p className="dre-note" role="note">
                ⚠️ {int(data.cobertura.semCustoQtd)} vendas sem custo do produto cadastrado
                {estimar ? ' — usamos uma estimativa.' : '.'}{' '}
                <button type="button" className="link" onClick={() => navigate('/skus')}>
                  Cadastrar custos
                </button>
                {view === 'completo' && (
                  <>
                    {' · '}
                    <button type="button" className="link" onClick={() => setEstimar((v) => !v)}>
                      {estimar ? 'ver sem estimativa' : 'estimar'}
                    </button>
                  </>
                )}
              </p>
            )}

            {view === 'simples' ? (
              <>
                <SimpleView
                  data={data}
                  onSetup={() => setSetup(true)}
                  onAddOther={() => setWizard({ kind: 'outra_plataforma' })}
                />
                <details className="panel dre-learn-mini">
                  <summary>📚 Não entendeu algo? Aprenda o básico em 1 minuto</summary>
                  <DreLearn />
                </details>
              </>
            ) : (
              <>
                <section className="panel" aria-labelledby="wf-title">
                  <div className="panel-head">
                    <h2 id="wf-title">Para onde foi o dinheiro</h2>
                    <small className="panel-hint">Toque num degrau para ver o que tem dentro</small>
                  </div>
                  <Waterfall data={data} focus={focus} onFocus={setFocus} onPick={pick} />
                </section>

                <div className="dre-grid">
                  <section className="panel" aria-labelledby="st-title" id="dre-statement">
                    <div className="panel-head">
                      <h2 id="st-title">O DRE, linha por linha</h2>
                      <small className="panel-hint">
                        Toque no <b>?</b> de qualquer linha para entender o que ela é
                      </small>
                    </div>
                    <DreStatement
                      data={data}
                      entries={entries}
                      tecnico={tecnico}
                      open={open}
                      onToggle={toggle}
                      focus={focus}
                      onFocus={setFocus}
                      onAdd={(kind) => setWizard({ kind })}
                      onEdit={(entry) => setWizard({ entry })}
                    />
                  </section>
                  <aside className="dre-side">
                    <BreakEven data={data} onAddFixed={() => setWizard({ kind: 'despesa_fixa' })} />
                    <WhatIf key={`${month}:${accountId}:${data.generatedAt}`} data={data} />
                  </aside>
                </div>

                <section className="panel dre-learn" aria-labelledby="learn-title">
                  <h2 id="learn-title">📚 Custo ou despesa? Aprenda em 1 minuto</h2>
                  <DreLearn />
                </section>
              </>
            )}
          </>
        )}
      </div>

      <Modal open={wizard !== null} onClose={() => setWizard(null)} label="Lançar gasto" wide>
        {wizard && (
          <EntryWizard
            key={wizard.entry?.id ?? wizard.template?.name ?? wizard.kind ?? 'novo'}
            entry={wizard.entry}
            kind={wizard.kind}
            template={wizard.template}
            month={month}
            sample={{ pedidos: data?.pedidos ?? 0, receitaBruta: data?.receitaBruta ?? 0 }}
            onDone={saved}
            onClose={() => setWizard(null)}
          />
        )}
      </Modal>
      <Modal open={setup} onClose={() => setSetup(false)} label="Montar meus custos" wide>
        <CostSetup
          entries={entries}
          month={month}
          sample={{ pedidos: data?.pedidos ?? 0, receitaBruta: data?.receitaBruta ?? 0 }}
          onChanged={() => load()}
          onClose={() => setSetup(false)}
        />
      </Modal>
      <Modal open={manage} onClose={() => setManage(false)} label="Meus gastos" wide>
        <EntriesList
          entries={entries}
          month={month}
          onNew={() => {
            setManage(false);
            setWizard({});
          }}
          onEdit={(entry) => {
            setManage(false);
            setWizard({ entry });
          }}
        />
      </Modal>
      {tour.element}
    </AppShell>
  );
}

/** Custo × despesa e dúvidas comuns, em linguagem simples. */
function DreLearn() {
  return (
    <>
      <p className="dre-muted">
        O teste mais fácil: <b>se você vendesse o dobro, esse gasto mudaria?</b> Se muda junto, é
        custo variável. Se fica igual, é despesa fixa. Se é juros ou tarifa de banco, é despesa
        financeira.
      </p>
      <div className="learn-cards">
        {(['custo_variavel', 'despesa_fixa', 'despesa_financeira'] as const).map((k) => (
          <div key={k} className="learn-card" data-kind={k}>
            <b>{KIND_HELP[k].titulo}</b>
            <p>{KIND_HELP[k].frase}</p>
            <small>{KIND_HELP[k].exemplos}</small>
          </div>
        ))}
      </div>
      <div className="learn-faq">
        <details>
          <summary>Por que a “sobra das vendas” (margem de contribuição) é tão importante?</summary>
          <p>
            Ela mostra se vender vale a pena. Se cada venda deixa uma sobra, vender mais paga a
            estrutura e vira lucro. Se a sobra é negativa, cada pedido aumenta o prejuízo: o
            problema está no preço, no custo do produto ou no frete, não nas despesas fixas.
          </p>
        </details>
        <details>
          <summary>Comprei estoque este mês. Isso entra no DRE?</summary>
          <p>
            Não na hora da compra. O DRE mostra o custo só dos produtos que foram vendidos no mês.
            Comprar estoque mexe no caixa, não no lucro: o custo aparece aos poucos, conforme as
            peças vendem.
          </p>
        </details>
        <details>
          <summary>Parcela de empréstimo é despesa?</summary>
          <p>
            Só a parte dos juros. A parte que devolve o dinheiro emprestado não é despesa: é
            pagamento de dívida. Lance os juros em “Bancos e juros”.
          </p>
        </details>
        <details>
          <summary>Devo lançar o meu próprio salário?</summary>
          <p>
            Sim, como “Pró-labore”. Se você trabalha na empresa e não se paga, o lucro parece maior
            do que é — e você não sabe se o negócio se sustentaria pagando alguém para fazer o seu
            trabalho.
          </p>
        </details>
        <details>
          <summary>Lucro é o mesmo que dinheiro na conta?</summary>
          <p>
            Nem sempre. O DRE mostra se o mês deu lucro; o caixa mostra quando o dinheiro entra e
            sai. O Mercado Livre libera os valores dias depois da venda, e compras de estoque saem
            do caixa antes de virar custo.
          </p>
        </details>
      </div>
    </>
  );
}
