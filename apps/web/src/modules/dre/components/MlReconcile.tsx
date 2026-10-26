import type { DreDto } from '@nvs/shared';
import { int, money } from '../../../shared/format';
import { Hint } from '../../../shared/ui/Hint';

/** Explica por que o painel do ML mostra um "Vendas brutas" maior: lá entram as canceladas. */
export function MlReconcile({ data }: { data: DreDto }) {
  const c = data.conciliacaoMl;
  if (!c || c.canceladas === 0) return null;
  return (
    <p className="ml-reconcile">
      No painel do Mercado Livre, “Vendas brutas” fica perto de <b className="money">{money(c.vendasBrutas)}</b>: lá entram
      também <b>{int(c.canceladas)}</b> {c.canceladas === 1 ? 'venda cancelada' : 'vendas canceladas'} (
      <b className="money">{money(c.valorCanceladas)}</b>), que não viraram dinheiro e por isso ficam fora daqui.{' '}
      <Hint label="diferença com o Mercado Livre">
        O DRE conta o que de fato entrou: vendas pagas e devoluções parciais. O frete que você pagou nas canceladas continua como custo. O ML pode contar algumas devoluções totais como venda, então o número dele pode variar um pouco.
      </Hint>
    </p>
  );
}
