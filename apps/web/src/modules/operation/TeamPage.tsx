import { AppShell } from '../../app/AppShell';
import { useGuidedTour } from '../../shared/tour/Tour';
import { TOURS } from '../../shared/tour/tours';
import { usePerson } from './PersonContext';
import { TeamManager } from './TeamManager';
import '../skus/skus.css';
import '../listings/listings.css';

/** Equipe (Análise): só MASTER vê. */
export function TeamPage() {
  const ctx = usePerson();
  const tour = useGuidedTour('equipe', TOURS.equipe, Boolean(ctx?.person.person.master));
  return (
    <AppShell>
      <div className="skus operators">
        <header className="skus-head">
          <div>
            <p className="dash-kicker">Empresa</p>
            <h1>Equipe</h1>
          </div>
        </header>
        <p className="ledit-hint">
          Cada pessoa entra tocando no próprio nome e digitando um PIN de 4 números — na Análise, na Operação ou nas duas, conforme a
          função. Todo mundo começa com o PIN <b>1234</b> e troca se quiser. <b>MASTER</b> cadastra e edita a equipe.
        </p>
        {ctx?.person.person.master ? (
          <TeamManager meId={ctx.person.person.id} />
        ) : (
          <p className="banner banner-error">Só um MASTER pode cadastrar a equipe.</p>
        )}
      </div>
      {tour.element}
    </AppShell>
  );
}
