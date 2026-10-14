import { useEffect, useState } from "react";

import { api } from "./api";

interface Relatorio {
  buscas: { status: "opened" | "closed"; filtro: string; total: number; lidas: number; erro: string | null }[];
  comDevolucao: Record<string, number>;
  semDevolucao: Record<string, number>;
  falhas: { reclamacao: string; erro: string }[];
  naoEntregues: number;
  gravadas: number;
  sondagens?: { consulta: string; total: number | null; erro?: string }[];
}
interface Sinc {
  mercado_livre?: { ok: boolean; erro: string | null; em: string | null; resultado: { relatorio?: Relatorio; erro?: string | null } | null };
}

const STATUS_DEV: Record<string, string> = {
  pending: "aguardando o comprador", label_generated: "etiqueta gerada", shipped: "a caminho", delivered: "entregue",
  not_delivered: "não entregue", cancelled: "cancelada", expired: "expirada", closed: "encerrada", return_to_buyer: "voltou ao comprador",
};
const soma = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

/** O que o Mercado Livre respondeu na última leitura: para conferir com o painel de Pós-venda do ML. */
export function LeituraML({ onFechar }: { onFechar: () => void }) {
  const [s, setS] = useState<Sinc | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  useEffect(() => {
    api.get<Sinc>("/sincronizacao").then(setS).catch((e) => setErro((e as Error).message));
  }, []);
  const ml = s?.mercado_livre;
  const r = ml?.resultado?.relatorio;

  return (
    <div className="modal-fundo" onMouseDown={(e) => e.target === e.currentTarget && onFechar()}>
      <div className="modal ev-modal leitura-ml" role="dialog" aria-modal="true" aria-labelledby="lml-titulo">
        <header className="modal-topo">
          <div>
            <h2 id="lml-titulo">O que veio do Mercado Livre</h2>
            <p className="sub">Última leitura{ml?.em ? ` em ${new Date(ml.em.endsWith("Z") ? ml.em : `${ml.em}Z`).toLocaleString("pt-BR")}` : ""}. Compare com Pós-venda → Devoluções no ML.</p>
          </div>
          <button type="button" className="icone-botao" onClick={onFechar} aria-label="Fechar">✕</button>
        </header>
        <div className="ev-corpo">
          {erro && <p className="aviso erro">{erro}</p>}
          {!s && !erro && <p className="sub">Carregando…</p>}
          {s && !r && <p className="aviso">Ainda não há relatório: clique em “Sincronizar agora” no Dashboard e volte aqui quando terminar.</p>}
          {ml && !ml.ok && ml.erro && <p className="aviso erro">A leitura teve erro: {ml.erro}</p>}
          {r && (
            <>
              <h3>Reclamações encontradas no ML</h3>
              <ul className="lml-lista">
                {r.buscas.map((b) => (
                  <li key={b.status}>
                    <span>{b.status === "opened" ? "Abertas" : "Encerradas"} <small>({b.filtro})</small></span>
                    <b>{b.total}</b>
                    <small>{b.lidas} lidas{b.erro ? ` · erro: ${b.erro}` : ""}</small>
                  </li>
                ))}
              </ul>
              <h3>Com devolução física (entram na Central): {soma(r.comDevolucao)}</h3>
              <ul className="lml-lista">
                {Object.entries(r.comDevolucao).map(([k, v]) => <li key={k}><span>{STATUS_DEV[k] ?? k}</span><b>{v}</b></li>)}
              </ul>
              <h3>Sem devolução física (mediação/cancelamento, ficam fora): {soma(r.semDevolucao)}</h3>
              <ul className="lml-lista">
                {Object.entries(r.semDevolucao).map(([k, v]) => <li key={k}><span>{k}</span><b>{v}</b></li>)}
              </ul>
              <p className="sub">Pacotes não entregues que voltaram: <b>{r.naoEntregues}</b> · gravadas no total: <b>{r.gravadas}</b></p>
              {r.sondagens && r.sondagens.length > 0 && (
                <>
                  <h3>Outras buscas no ML (só para conferir)</h3>
                  <ul className="lml-lista">
                    {r.sondagens.map((x) => <li key={x.consulta}><span>{x.consulta}</span><b>{x.total ?? "—"}</b>{x.erro && <small>{x.erro}</small>}</li>)}
                  </ul>
                </>
              )}
              {r.falhas.length > 0 && (
                <>
                  <h3>Com erro ({r.falhas.length}{r.falhas.length >= 15 ? "+" : ""})</h3>
                  <ul className="lml-lista">
                    {r.falhas.map((f) => <li key={f.reclamacao}><span>{f.reclamacao}</span><small>{f.erro}</small></li>)}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
