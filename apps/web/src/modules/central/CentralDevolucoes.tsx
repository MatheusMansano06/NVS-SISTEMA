import { Component, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import { useGuidedTour } from "../../shared/tour/Tour";
import { TOURS } from "../../shared/tour/tours";
import { BiPage } from "./modules/bi/BiPage";
import { ConferenciaModal } from "./modules/conferencia/ConferenciaModal";
import { EstoqueVirtualPage } from "./modules/estoque-virtual/EstoqueVirtualPage";
import { HistoricoPage } from "./modules/historico/HistoricoPage";
import { OperacaoPage } from "./modules/operacao/OperacaoPage";
import { OperadoresPage } from "./modules/operadores/OperadoresPage";
import { QuebradosPage } from "./modules/quebrados/QuebradosPage";
import { RetornoFullPage } from "./modules/retirada-full/RetornoFullPage";
import { ResumoPage } from "./modules/resumo/ResumoPage";
import { ehEtiquetaFull, RetiradaFullModal } from "./modules/retirada-full/RetiradaFullModal";
import { BarraSincronizacao } from "./shared/BarraSincronizacao";
import type { Plataforma } from "./shared/devolucao";
import { Icone } from "./shared/Icone";
import type { Envio } from "./shared/operacao";
import "../skus/skus.css";
import "./shared/estilo.css";
import "./shared/nvs.css";

const TELAS = [
  { id: "resumo", nome: "Resumo" },
  { id: "operacao", nome: "Operação" },
  { id: "bi", nome: "B.I" },
  { id: "historico", nome: "Histórico" },
  { id: "quebrados", nome: "Quebrados" },
  { id: "estoque", nome: "Estoque virtual" },
  { id: "full", nome: "Retorno Full" },
  { id: "operadores", nome: "Operadores" },
] as const;
export type IdTela = (typeof TELAS)[number]["id"];

/** Filtros que a tela Operação já abre aplicados (vindos de um clique no Resumo). */
export interface FiltroOperacao { plataforma?: Plataforma; envio?: Envio }

export interface Navegacao {
  abrir: (codigo: string) => void;
  irPara: (tela: IdTela, statusFiltro?: string, filtro?: FiltroOperacao) => void;
  /** Muda depois de qualquer ação no modal: as telas recarregam os números. */
  versao: number;
  statusInicial?: string;
  filtroInicial?: FiltroOperacao;
}

type Modo = "analise" | "operacao";

function Central({ telas, modo }: { telas?: IdTela[]; modo: Modo }) {
  const chave = telas?.join(","); // `telas` muda de referência a cada render; a chave é o conteúdo
  const visiveis = useMemo(() => (telas ? TELAS.filter((t) => telas.includes(t.id)) : [...TELAS]), [chave]);
  const [tela, setTela] = useState<IdTela>(visiveis[0]!.id);
  const [statusInicial, setStatusInicial] = useState<string | undefined>();
  const [filtroInicial, setFiltroInicial] = useState<FiltroOperacao | undefined>();
  const [codigo, setCodigo] = useState<string | null>(null);
  const [versao, setVersao] = useState(0);
  const [busca, setBusca] = useState("");
  const campoBusca = useRef<HTMLInputElement>(null);
  const tour = useGuidedTour(
    modo === "analise" ? "central-devolucoes" : "central-devolucoes-op",
    modo === "analise" ? TOURS["central-devolucoes"] : TOURS["central-devolucoes-op"],
    true,
  );

  const abrir = useCallback((c: string) => setCodigo(c.trim()), []);
  const irPara = useCallback((t: IdTela, s?: string, f?: FiltroOperacao) => {
    if (!visiveis.some((v) => v.id === t)) return; // a Operação não tem todas as abas
    setStatusInicial(s); setFiltroInicial(f); setTela(t);
  }, [visiveis]);
  const fechar = useCallback(() => { setCodigo(null); setVersao((v) => v + 1); }, []);
  const recarregar = useCallback(() => setVersao((v) => v + 1), []);

  // Painel vivo: a sincronização roda no servidor a cada 10 min; a tela busca os números a cada minuto.
  // Com o modal aberto não recarrega, para não mexer na conferência em andamento.
  useEffect(() => {
    if (codigo) return;
    const t = setInterval(() => setVersao((v) => v + 1), 60_000);
    return () => clearInterval(t);
  }, [codigo]);

  useEffect(() => {
    function atalho(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        campoBusca.current?.focus();
      }
    }
    window.addEventListener("keydown", atalho);
    return () => window.removeEventListener("keydown", atalho);
  }, []);

  function buscar(e: FormEvent) {
    e.preventDefault();
    if (busca.trim()) abrir(busca);
    setBusca("");
  }

  const nav: Navegacao = { abrir, irPara, versao, statusInicial, filtroInicial };

  return (
    <div className="cd-app">
      <header className="skus-head cd-head">
        <div>
          <p className="dash-kicker">Mercado Livre · pós-venda</p>
          <h1>Central de Devoluções</h1>
        </div>
        <div className="cd-head-acoes">
          <BarraSincronizacao onTerminou={recarregar} />
          <button type="button" className="link cd-tour" onClick={tour.start}>Rever com a Gertrudez</button>
        </div>
      </header>

      <div className="cd-barra">
        <nav className="seg cd-abas" role="tablist" aria-label="Telas da Central">
          {visiveis.map((t) => (
            <button key={t.id} type="button" role="tab" aria-checked={tela === t.id} onClick={() => irPara(t.id)}>{t.nome}</button>
          ))}
        </nav>
        <form className="search cd-busca" onSubmit={buscar} role="search">
          <Icone nome="lupa" tamanho={18} />
          <input ref={campoBusca} value={busca} onChange={(e) => setBusca(e.target.value)} aria-label="Buscar devolução"
                 placeholder="Bipar ou buscar rastreio, pedido…" autoComplete="off" />
          <kbd>Ctrl K</kbd>
        </form>
      </div>

      <main className="conteudo">
        {tela === "resumo" && <ResumoPage nav={nav} />}
        {tela === "operacao" && <OperacaoPage nav={nav} />}
        {tela === "bi" && <BiPage nav={nav} />}
        {tela === "historico" && <HistoricoPage nav={nav} />}
        {tela === "quebrados" && <QuebradosPage nav={nav} />}
        {tela === "estoque" && <EstoqueVirtualPage nav={nav} />}
        {tela === "full" && <RetornoFullPage nav={nav} />}
        {tela === "operadores" && <OperadoresPage nav={nav} />}
      </main>

      {codigo && (ehEtiquetaFull(codigo)
        ? <RetiradaFullModal codigo={codigo} onFechar={fechar} />
        : <ConferenciaModal codigo={codigo} onFechar={fechar} onMudou={() => setVersao((v) => v + 1)} />)}
      {tour.element}
    </div>
  );
}

class Protecao extends Component<{ children: ReactNode }, { erro: Error | null }> {
  state = { erro: null as Error | null };
  static getDerivedStateFromError(erro: Error) {
    return { erro };
  }
  render() {
    return this.state.erro ? (
      <p className="nota erro" role="alert">A tela travou: {this.state.erro.message}. Recarregue a página.</p>
    ) : this.props.children;
  }
}

/**
 * Central de Devoluções (arquitetura do NOVAES-ESTOQUE com a cara do NVS). `.central-dev` isola o CSS da Central;
 * `telas`: só estas abas (a Operação vê a parte do bipe; a Análise vê tudo).
 */
export function CentralDevolucoes({ telas, modo = "analise" }: { telas?: IdTela[]; modo?: Modo }) {
  return (
    <div className="central-dev" data-modo={modo}>
      <Protecao><Central telas={telas} modo={modo} /></Protecao>
    </div>
  );
}
