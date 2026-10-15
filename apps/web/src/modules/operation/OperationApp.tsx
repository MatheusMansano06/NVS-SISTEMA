import { useEffect, useState } from 'react';
import { FullRouter } from '../full/FullRouter';
import { navigate, usePath } from '../../app/router';
import { CentralDevolucoes } from '../central/CentralDevolucoes';
import { useAuth } from '../auth/AuthContext';
import { Modal } from '../../shared/ui/Modal';
import { NoticesBar } from '../../app/NoticesBar';
import { ComingSoon, useFeature } from '../../shared/features';
import { ThemeSwitch } from '../../shared/theme';
import { OperationHome } from './OperationHome';
import { PinChange } from './PinChange';
import { usePerson } from './PersonContext';
import { TeamManager } from './TeamManager';
import './operation.css';

type Area = 'inicio' | 'full' | 'devolucoes';

/** Operação: abre no início (a pessoa escolhe a tarefa); Supervisão Full em /op/full e Devoluções em /op/devolucoes. */
export function OperationApp() {
  const ctx = usePerson()!;
  const { session } = useAuth();
  const me = ctx.person.person;
  const [view, setView] = useState<'home' | 'pin'>('home');
  const [team, setTeam] = useState(false);
  const path = usePath();
  const area: Area = path.startsWith('/op/devolucoes') ? 'devolucoes' : path.startsWith('/op/full') ? 'full' : 'inicio';
  useEffect(() => {
    if (!window.location.pathname.startsWith('/op')) navigate('/op');
  }, []);

  const full = useFeature('full');
  const tab = (a: Area, to: string, label: string) => (
    <button type="button" role="tab" aria-checked={area === a} onClick={() => { setView('home'); navigate(to); }}>{label}</button>
  );

  return (
    <div className="station" data-area={area}>
      <header className="station-top">
        <img src="/nvs-logo.webp" alt="NVS Tech" height="40" />
        <span className="station-tag">Operação · {session?.tenant.name}</span>
        <nav className="seg op-switch" aria-label="Área da operação">
          {tab('inicio', '/op', 'Início')}
          {tab('full', '/op/full', full ? '📦 Supervisão Full' : '📦 Supervisão Full · em breve')}
          {tab('devolucoes', '/op/devolucoes', '↩︎ Devoluções')}
        </nav>
        <span className="station-user">
          <ThemeSwitch compact />
          <b>{me.name}</b>
          {me.master && <button type="button" className="act" onClick={() => setTeam(true)}>Equipe</button>}
          <button type="button" className="act" onClick={() => setView('pin')}>Trocar PIN</button>
          <button type="button" className="act" onClick={ctx.switchPerson}>Sair</button>
        </span>
      </header>
      <main className="station-main">
        <div className="station-notices"><NoticesBar /></div>
        {view === 'pin' ? (
          <PinChange person={ctx.person} onCancel={() => setView('home')} onDone={(p) => { ctx.update(p); setView('home'); }} />
        ) : area === 'full' ? (
          <div className="op-full">{full ? <FullRouter mode="operacao" /> : <ComingSoon title="Supervisão Full" text="A Supervisão Full (separação das listas do Full com bipagem e impressão das etiquetas) está em fase de testes e será liberada em breve para a sua empresa." />}</div>
        ) : area === 'devolucoes' ? (
          <div className="op-full"><CentralDevolucoes modo="operacao" telas={['operacao', 'historico', 'full']} /></div>
        ) : (
          <OperationHome />
        )}
      </main>
      <Modal open={team} onClose={() => setTeam(false)} label="Equipe" wide>
        <h2 className="team-modal-title">Equipe</h2>
        <TeamManager meId={me.id} />
      </Modal>
    </div>
  );
}
