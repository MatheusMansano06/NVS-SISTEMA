import { useEffect, useRef, useState } from "react";

import { api } from "./api";

interface Progresso {
  refazendo?: string | null; varredura?: boolean; rodando: boolean; tarefa: string | null; percentual: number;
  iniciada_em: string | null; terminada_em: string | null; pendentes: Record<string, number>; erro?: string | null;
}

const NOME_TAREFA: Record<string, string> = {
  mercado_livre: "reclamações do Mercado Livre", shopee: "devoluções da Shopee",
  shopee_falha_entrega: "falhas de entrega da Shopee", shopee_rastreio: "rastreio da Shopee",
  refazer_ml: "relendo o Mercado Livre", refazer_shopee: "relendo a Shopee", refazer_fatura: "baixando a fatura do ML",
  fechamento: "gravando o fechamento", fotos_anuncios: "fotos dos anúncios", mediacao_atuacao: "o que fizemos nas mediações", logistica_venda: "Full x orgânica", fatura_ml: "fatura do Mercado Livre", mediacao_origem: "quem abriu as mediações",
};
const hora = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** Progresso da sincronização do servidor: 5 s enquanto roda, 30 s parado. Ao terminar, avisa para recarregar os números. */
export function BarraSincronizacao({ onTerminou }: { onTerminou: () => void }) {
  const [p, setP] = useState<Progresso | null>(null);
  const rodava = useRef(false);

  useEffect(() => {
    let ativo = true, t: ReturnType<typeof setTimeout>;
    async function buscar() {
      try {
        const novo = await api.get<Progresso>("/sincronizacao/progresso");
        if (!ativo) return;
        if (rodava.current && !novo.rodando) onTerminou();
        rodava.current = novo.rodando;
        setP(novo);
      } catch { /* sem rede: tenta de novo no próximo ciclo */ }
      if (ativo) t = setTimeout(buscar, rodava.current ? 5_000 : 30_000);
    }
    void buscar();
    return () => { ativo = false; clearTimeout(t); };
  }, [onTerminou]);

  if (!p || (!p.rodando && !p.terminada_em)) return null;
  const pendentes = Object.values(p.pendentes ?? {}).reduce((a, b) => a + b, 0);
  // Selo curto (o cabeçalho não tem espaço sobrando); o detalhe vai na dica do mouse.
  const texto = p.rodando
    ? `${p.refazendo ? `Relendo fatura ${p.refazendo.slice(5, 7)}/${p.refazendo.slice(2, 4)}` : p.varredura ? "Varredura do dia" : "Sincronizando"} ${Math.floor(p.percentual)}%`
    : p.erro ? `Leitura com erro ${hora(p.terminada_em!)}`
      : pendentes > 0 ? `Sincronizado ${hora(p.terminada_em!)} · faltam ${pendentes}` : `✓ Sincronizado ${hora(p.terminada_em!)}`;
  const dica = p.rodando
    ? `Agora: ${NOME_TAREFA[p.tarefa ?? ""] ?? p.tarefa ?? "iniciando"}`
    : p.erro ? `O Mercado Livre não respondeu tudo: ${p.erro}. Veja em “O que veio do ML”.`
      : pendentes > 0 ? `Faltam ${pendentes} consultas para o B.I; continuam na próxima rodada (a cada 10 min)`
      : "Tudo sincronizado. A próxima rodada é em até 10 min; a varredura completa roda 1x por dia às 23h.";

  return (
    <>
      <span className={p.rodando ? "sinc-selo rodando" : p.erro ? "sinc-selo erro" : pendentes > 0 ? "sinc-selo pendente" : "sinc-selo ok"}
            role="status" title={dica}>{texto}</span>
      {p.rodando && (
        <div className="sinc-barra" role="progressbar" aria-label="Sincronização" aria-valuemin={0} aria-valuemax={100}
             aria-valuenow={Math.floor(p.percentual)}>
          <span style={{ width: `${p.percentual}%` }} />
        </div>
      )}
    </>
  );
}
