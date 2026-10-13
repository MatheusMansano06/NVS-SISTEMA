import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Modal } from '../../shared/ui/Modal';
import { PinChange } from './PinChange';
import { usePerson } from './PersonContext';
import { TeamManager } from './TeamManager';
import './operation.css';

const SOON = [
  { icon: '📦', title: 'Separação', text: 'Lista do que separar para envio, por coleta e Flex.' },
  { icon: '✅', title: 'Conferência', text: 'Bipe o produto para conferir antes de embalar.' },
  { icon: '🏷️', title: 'Etiquetas', text: 'Imprimir etiquetas de envio do dia.' },
  { icon: '🚚', title: 'Expedição', text: 'Fechar coletas e acompanhar o que saiu.' },
];

/** Operação: as funções da expedição entram aqui (todos da Operação veem o mesmo). */
export function OperationApp() {
  const ctx = usePerson()!;
  const { session } = useAuth();
  const me = ctx.person.person;
  const [view, setView] = useState<'home' | 'pin'>('home');
  const [team, setTeam] = useState(false);

  return (
    <div className="station">
      <header className="station-top">
        <img src="/nvs-logo.webp" alt="NVS Tech" height="40" />
        <span className="station-tag">Operação · {session?.tenant.name}</span>
        <span className="station-user">
          <b>{me.name}</b>
          {me.master && <button type="button" className="act" onClick={() => setTeam(true)}>Equipe</button>}
          <button type="button" className="act" onClick={() => setView('pin')}>Trocar PIN</button>
          <button type="button" className="act" onClick={ctx.switchPerson}>Sair</button>
        </span>
      </header>
      <main className="station-main">
        {view === 'pin' ? (
          <PinChange person={ctx.person} onCancel={() => setView('home')} onDone={(p) => { ctx.update(p); setView('home'); }} />
        ) : (
          <section className="station-home">
            <h1>Bom trabalho, {me.name}! 👋</h1>
            <p>Estas são as funções da expedição. Elas vão sendo liberadas aqui.</p>
            <div className="station-cards">
              {SOON.map((c) => (
                <article key={c.title} aria-disabled="true">
                  <span aria-hidden="true">{c.icon}</span>
                  <strong>{c.title}</strong>
                  <p>{c.text}</p>
                  <small>em breve</small>
                </article>
              ))}
            </div>
          </section>
        )}
      </main>
      <Modal open={team} onClose={() => setTeam(false)} label="Equipe">
        <h2 className="team-modal-title">Equipe</h2>
        <TeamManager meId={me.id} />
      </Modal>
    </div>
  );
}
