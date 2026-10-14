import { useState, type FormEvent } from "react";

import type { Navegacao } from "../../CentralDevolucoes";
import { api } from "../../shared/api";
import { quando, reais } from "../../shared/formato";
import { usarDados } from "../../shared/usarDados";

type Deposito = "vendavel" | "avaria";
interface Sku {
  sku: string; nome: string | null; imagem: string | null; vendavel: number; avaria: number; custo: number | null;
  valor_vendavel: number | null; valor_avaria: number | null; ultimo_em: string;
}
interface Movimento {
  id: string; sku: string; deposito: Deposito; quantidade: number; origem: string; referencia: string | null; operador: string | null; criado_em: string;
}
interface Resposta {
  skus: Sku[]; zerados: number; movimentos: Movimento[];
  total: { vendavel: number; avaria: number; valor_vendavel: number; valor_avaria: number; sem_custo: number };
}
type Acao = { tipo: "ajuste" | "transferir"; sku: string; deposito: Deposito };

const DEP: Record<Deposito, string> = { vendavel: "Vendável", avaria: "Avaria" };
const ORIGEM: Record<string, string> = { devolucao: "Devolução conferida", retorno_full: "Retorno do Full", ajuste: "Ajuste manual" };

/**
 * Estoque virtual: o que não volta para o anúncio no Mercado Livre (sem ERP ligado). Avaria e divergente da bancada,
 * e vendável que não tem anúncio próprio fora do Full. Cada entrada e saída fica registrada com quem fez.
 */
export function EstoqueVirtualPage({ nav }: { nav: Navegacao }) {
  const [versao, setVersao] = useState(0);
  const { dados: r, erro } = usarDados<Resposta>("/estoque-virtual", nav.versao + versao);
  const [filtro, setFiltro] = useState<"todos" | Deposito>("todos");
  const [acao, setAcao] = useState<Acao | null>(null);
  const [feito, setFeito] = useState<string | null>(null);
  const t = r?.total;
  const lista = (r?.skus ?? []).filter((s) => filtro === "todos" || s[filtro] !== 0);

  return (
    <div className="tela ev-pg">
      <header className="cabecalho">
        <div>
          <h1>Estoque virtual</h1>
          <p className="sub">O que não volta para o anúncio no Mercado Livre: avaria, divergente e vendável sem anúncio próprio fora do Full.</p>
        </div>
        <div className="segmentos" role="group" aria-label="Filtrar depósito">
          {(["todos", "vendavel", "avaria"] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filtro === f} onClick={() => setFiltro(f)}>
              {f === "todos" ? "Todos" : DEP[f]}
            </button>
          ))}
        </div>
      </header>

      {erro && <p className="aviso erro">{erro}</p>}
      {feito && <p className="aviso ok" role="status">{feito}</p>}

      <section className="op-cartoes" aria-label="Saldo do estoque virtual">
        <article className="cartao op-cartao op-total ev-cartao-avaria">
          <span className="op-rotulo">Em avaria</span>
          <strong className="op-numero">{t?.avaria ?? "…"}</strong>
          <span className="sub">unidades quebradas ou divergentes · {reais(t?.valor_avaria)}</span>
        </article>
        <article className="cartao op-cartao">
          <span className="op-rotulo">Vendável fora do ML</span>
          <strong className="op-numero">{t?.vendavel ?? "…"}</strong>
          <span className="sub">sem anúncio próprio fora do Full · {reais(t?.valor_vendavel)}</span>
        </article>
        <article className="cartao op-cartao">
          <span className="op-rotulo">Produtos</span>
          <strong className="op-numero">{r?.skus.length ?? "…"}</strong>
          <span className="sub">{t?.sem_custo ? `${t.sem_custo} sem custo cadastrado` : "SKUs com saldo"}</span>
        </article>
      </section>

      <section className="cartao op-lista ev-saldos" aria-label="Saldo por produto">
        <header><h2>Saldo por produto</h2><span className="sub">valor pelo custo atual do SKU</span></header>
        {r && lista.length === 0 ? (
          <div className="op-vazio">
            <strong>Nada no estoque virtual</strong>
            <span className="sub">Quando a bancada lançar uma avaria ou um produto sem anúncio próprio, ele aparece aqui.</span>
          </div>
        ) : (
          <div className="tabela-area">
            <table className="tabela qb-tabela">
              <thead><tr><th>Produto</th><th className="num">Vendável</th><th className="num">Avaria</th><th className="num">Valor</th><th className="num">Última mudança</th><th /></tr></thead>
              <tbody>
                {lista.map((s) => (
                  <tr key={s.sku}>
                    <td>
                      <div className="qb-produto">
                        {s.imagem ? <img src={s.imagem} alt="" loading="lazy" /> : <span className="qb-sem-foto" aria-hidden="true" />}
                        <div>
                          <strong>{s.sku}</strong>
                          <span className="sub qb-nome" title={s.nome ?? undefined}>{s.nome ?? "—"}</span>
                        </div>
                      </div>
                    </td>
                    <td className="num"><strong className="full-qtd">{s.vendavel}</strong></td>
                    <td className="num"><strong className={`full-qtd ${s.avaria ? "ev-avaria" : ""}`}>{s.avaria}</strong></td>
                    <td className="num">{s.custo === null ? <span className="qb-falta">sem custo</span> : reais((s.valor_vendavel ?? 0) + (s.valor_avaria ?? 0))}</td>
                    <td className="num sub">{quando(s.ultimo_em)}</td>
                    <td className="num ev-acoes">
                      {s.avaria > 0 && (
                        <button type="button" className="botao-linha" onClick={() => setAcao({ tipo: "transferir", sku: s.sku, deposito: "avaria" })}>Consertou</button>
                      )}
                      <button type="button" className="botao-linha" onClick={() => setAcao({ tipo: "ajuste", sku: s.sku, deposito: s.avaria ? "avaria" : "vendavel" })}>Ajustar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="cartao op-lista ev-movimentos" aria-label="Movimentos">
        <header><h2>Movimentos</h2><span className="sub">últimos 150</span></header>
        {r && r.movimentos.length === 0 ? <div className="op-vazio"><span className="sub">Nenhum movimento ainda.</span></div> : (
          <div className="tabela-area">
            <table className="tabela qb-tabela">
              <thead><tr><th>Quando</th><th>Quem</th><th>SKU</th><th>Origem</th><th className="num">Qtd</th></tr></thead>
              <tbody>
                {r?.movimentos.map((m) => (
                  <tr key={m.id}>
                    <td className="op-hora">{quando(m.criado_em)}</td>
                    <td>{m.operador
                      ? <span className="op-pessoa"><span className="op-avatar pequeno" aria-hidden="true">{m.operador.charAt(0).toUpperCase()}</span>{m.operador}</span>
                      : <span className="sub">—</span>}</td>
                    <td>{m.sku}<span className="sub">{DEP[m.deposito]}</span></td>
                    <td>{ORIGEM[m.origem] ?? m.origem}{m.origem === "ajuste" && m.referencia && <span className="sub" title={m.referencia}>{m.referencia}</span>}</td>
                    <td className="num"><strong className={m.quantidade < 0 ? "ruim" : "bom"}>{m.quantidade > 0 ? `+${m.quantidade}` : m.quantidade}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {acao && <AjusteModal acao={acao} onFechar={(mudou, msg) => { setAcao(null); setFeito(msg ?? null); if (mudou) setVersao((v) => v + 1); }} />}
    </div>
  );
}

function AjusteModal({ acao, onFechar }: { acao: Acao; onFechar: (mudou: boolean, msg?: string) => void }) {
  const transferir = acao.tipo === "transferir";
  const [deposito, setDeposito] = useState<Deposito>(acao.deposito);
  const [sentido, setSentido] = useState<"saida" | "entrada">("saida");
  const [quantidade, setQuantidade] = useState("1");
  const [motivo, setMotivo] = useState(transferir ? "Consertado: volta a vender" : "");
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function salvar(e: FormEvent) {
    e.preventDefault();
    const n = Number(quantidade);
    if (!Number.isInteger(n) || n < 1) return setErro("Quantidade deve ser um número inteiro maior que zero.");
    setErro(null);
    setEnviando(true);
    try {
      const r = await api.post<{ destino: string | null }>("/estoque-virtual/ajuste", transferir
        ? { sku: acao.sku, deposito: "avaria", para: "vendavel", quantidade: n, motivo }
        : { sku: acao.sku, deposito, quantidade: sentido === "saida" ? -n : n, motivo });
      onFechar(true, r.destino ? `${n} un. de ${acao.sku} voltou a vender · ${r.destino}` : `Ajuste de ${acao.sku} registrado.`);
    } catch (err) {
      setErro((err as Error).message);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="modal-fundo" onMouseDown={(e) => e.target === e.currentTarget && onFechar(false)}>
      <form className="modal ev-modal" role="dialog" aria-modal="true" aria-labelledby="ev-titulo" onSubmit={salvar}>
        <header className="modal-topo">
          <div>
            <h2 id="ev-titulo">{transferir ? "Consertou: avaria → vendável" : "Ajustar estoque virtual"}</h2>
            <p className="sub">SKU {acao.sku}</p>
          </div>
          <button type="button" className="icone-botao" onClick={() => onFechar(false)} aria-label="Fechar">✕</button>
        </header>
        <div className="ev-corpo">
          {!transferir && (
            <>
              <label className="campo">Depósito
                <select value={deposito} onChange={(e) => setDeposito(e.target.value as Deposito)}>
                  <option value="avaria">Avaria</option>
                  <option value="vendavel">Vendável</option>
                </select>
              </label>
              <label className="campo">Movimento
                <select value={sentido} onChange={(e) => setSentido(e.target.value as "saida" | "entrada")}>
                  <option value="saida">Saída (descartou, vendeu, contou menos)</option>
                  <option value="entrada">Entrada (contou mais)</option>
                </select>
              </label>
            </>
          )}
          <label className="campo">Quantidade
            <input type="number" min={1} step={1} value={quantidade} onChange={(e) => setQuantidade(e.target.value)} autoFocus />
          </label>
          <label className="campo">Motivo
            <input value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={200} placeholder="Ex.: descartado, vendido como usado, contagem" required />
          </label>
          {erro && <p className="aviso erro" role="alert">{erro}</p>}
          <div className="linha-botoes">
            <button type="button" className="botao" onClick={() => onFechar(false)}>Cancelar</button>
            <button type="submit" className="botao principal" disabled={enviando}>{enviando ? "Salvando…" : "Salvar"}</button>
          </div>
        </div>
      </form>
    </div>
  );
}
