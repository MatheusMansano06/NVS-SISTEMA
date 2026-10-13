import { createContext, useContext, type ReactNode } from 'react';
import type { PersonSessionDto } from '@nvs/shared';

interface PersonCtx {
  person: PersonSessionDto;
  /** Volta para a escolha de nome (a sessão da empresa continua). */
  switchPerson: () => void;
  update: (p: PersonSessionDto) => void;
}

const Ctx = createContext<PersonCtx | null>(null);

export function PersonProvider({ value, children }: { value: PersonCtx; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Pessoa da equipe que entrou com nome + PIN (null fora do sistema). */
export function usePerson() {
  return useContext(Ctx);
}
