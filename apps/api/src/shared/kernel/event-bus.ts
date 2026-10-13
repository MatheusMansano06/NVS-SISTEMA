/** Barramento de eventos in-process: módulos reagem uns aos outros sem se importarem. */
export interface DomainEvent {
  readonly type: string;
  readonly tenantId: string;
  readonly payload: Record<string, unknown>;
}

type Handler = (event: DomainEvent) => Promise<void> | void;

export class EventBus {
  private handlers = new Map<string, Handler[]>();

  on(type: string, handler: Handler): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  /** Dispara de forma assíncrona (não bloqueia a requisição); falhas de handler não propagam. */
  publish(event: DomainEvent, onError: (err: unknown) => void = () => undefined): void {
    for (const handler of this.handlers.get(event.type) ?? []) {
      queueMicrotask(() => {
        Promise.resolve()
          .then(() => handler(event))
          .catch(onError);
      });
    }
  }
}
