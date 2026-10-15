import { useEffect, useState } from 'react';
import { navigate } from '../../app/router';
import { http } from '../../shared/http';
import { useGuidedTour } from '../../shared/tour/Tour';
import { TOURS } from '../../shared/tour/tours';
import { Icon } from '../../shared/ui/Icon';
import { fullApi } from '../full/full-api';
import { useFeature } from '../../shared/features';
import { usePerson } from './PersonContext';

const saudacao = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
};

/** Início da Operação: a pessoa escolhe o que vai fazer agora — separar o Full ou conferir devoluções. */
export function OperationHome() {
  const me = usePerson()!.person.person;
  const [listas, setListas] = useState<{ abertas: number; minhas: number } | null>(null);
  const [devolucoes, setDevolucoes] = useState<{ chegaram: number; pendentes: number } | null>(null);
  const tour = useGuidedTour('operacao-inicio', TOURS['operacao-inicio'], true);
  const full = useFeature('full');

  useEffect(() => {
    if (full) fullApi
      .lists()
      .then((ls) => {
        const abertas = ls.filter((l) => l.status !== 'completed');
        setListas({ abertas: abertas.length, minhas: abertas.filter((l) => l.operatorId === me.id).length });
      })
      .catch(() => setListas(null));
    http<{ aguardando_conferencia: number; contestar: number; lancar_estoque: number; chamados_manuais: number }>('/api/v1/central/operacao/atencao')
      .then((a) => setDevolucoes({ chegaram: a.aguardando_conferencia, pendentes: a.contestar + a.lancar_estoque + a.chamados_manuais }))
      .catch(() => setDevolucoes(null));
  }, [me.id, full]);

  return (
    <section className="op-home">
      <header className="op-hello">
        <img src="/gertrudez.webp" alt="" className="op-hello-gz" />
        <div>
          <p className="dash-kicker">{saudacao()}, {me.name}!</p>
          <h1>O que vamos fazer agora?</h1>
          <p>Escolha a tarefa. Dá para trocar a qualquer momento pelo topo da tela.</p>
        </div>
        <button type="button" className="link op-hello-tour" onClick={tour.start}>Rever com a Gertrudez</button>
      </header>

      <div className="op-choices">
        <button type="button" className="op-choice op-choice-full" disabled={!full} onClick={() => navigate('/op/full')}>
          <span className="op-choice-icon" aria-hidden="true"><Icon name="truck" size={30} /></span>
          <strong>Supervisão Full</strong>
          <span className="op-choice-text">Separar os produtos das listas do envio para o Full, bipando cada um, e imprimir as etiquetas na Zebra.</span>
          <span className="op-choice-stat">
            {!full ? 'Em breve' : listas === null ? 'Carregando as listas…' : listas.abertas === 0 ? 'Nenhuma lista aberta agora' : `${listas.abertas} ${listas.abertas === 1 ? 'lista aberta' : 'listas abertas'}${listas.minhas ? ` · ${listas.minhas} com você` : ''}`}
          </span>
          <em>{full ? 'Separar e imprimir →' : 'Em breve'}</em>
        </button>
        <button type="button" className="op-choice op-choice-dev" onClick={() => navigate('/op/devolucoes')}>
          <span className="op-choice-icon" aria-hidden="true"><Icon name="undo" size={30} /></span>
          <strong>Devoluções</strong>
          <span className="op-choice-text">Bipar o pacote que voltou, conferir o produto, tirar as fotos e lançar no estoque. Também a etiqueta do Full que voltou do CD.</span>
          <span className="op-choice-stat">
            {devolucoes === null ? 'Carregando a bancada…' : devolucoes.chegaram === 0 && devolucoes.pendentes === 0 ? 'Nada esperando na bancada' : `${devolucoes.chegaram} ${devolucoes.chegaram === 1 ? 'chegou' : 'chegaram'} para conferir${devolucoes.pendentes ? ` · ${devolucoes.pendentes} para terminar` : ''}`}
          </span>
          <em>Abrir a bancada →</em>
        </button>
      </div>
      {tour.element}
    </section>
  );
}
