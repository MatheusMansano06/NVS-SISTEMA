import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { PACKAGE_TYPES, type FlexStatusDto, type ListingDto, type ListingEditorDto, type WholesaleDto } from '@nvs/shared';
import { money } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Button } from '../../shared/ui/Button';
import { listingsApi } from './listings-api';

export type EditorTab = 'description' | 'pictures' | 'attributes' | 'dimensions' | 'wholesale' | 'flex';

const TABS: { id: EditorTab; label: string; hint: string }[] = [
  { id: 'description', label: 'Descrição', hint: 'Texto que o comprador lê na página do anúncio. Só texto puro (o ML não aceita HTML).' },
  { id: 'pictures', label: 'Fotos', hint: 'A primeira foto é a capa. Arraste a ordem com as setas, remova ou adicione novas (JPG, PNG ou WEBP, até 10 MB).' },
  { id: 'attributes', label: 'Ficha técnica', hint: 'Características do produto (marca, modelo, compatibilidade…). Ficha completa aparece mais nas buscas.' },
  { id: 'dimensions', label: 'Dimensões', hint: 'Medidas e peso do pacote. O ML usa isso para calcular o frete — medida errada encarece o envio.' },
  { id: 'wholesale', label: 'Atacado B2B', hint: 'Desconto por quantidade que só compradores empresa (CNPJ) veem. Até 5 faixas.' },
  { id: 'flex', label: 'Flex', hint: 'Entrega no mesmo dia feita por você, para quem compra dentro da sua área. Ative ou desative aqui, anúncio por anúncio.' },
];

const errMsg = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
const parseMoney = (s: string): number | null => {
  const t = s.replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return t && Number.isFinite(n) ? n : null;
};

/** Editor do anúncio em abas: cada aba salva direto no Mercado Livre. */
export function ListingEditorModal({ item, initialTab, canManage, onSaved }: { item: ListingDto; initialTab: EditorTab; canManage: boolean; onSaved: (msg: string) => void }) {
  const [tab, setTab] = useState<EditorTab>(initialTab);
  const [data, setData] = useState<ListingEditorDto | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    listingsApi
      .editor(item.id)
      .then((d) => alive && setData(d))
      .catch((err) => alive && setError(errMsg(err, 'Não foi possível abrir o anúncio no Mercado Livre.')));
    return () => {
      alive = false;
    };
  }, [item.id]);

  const current = TABS.find((t) => t.id === tab)!;
  return (
    <div className="ledit">
      <header className="ledit-head">
        <h2>Editar anúncio</h2>
        <p className="lprice-sub">{item.title}</p>
        <code>{item.sku ?? item.id}</code>
      </header>
      <div className="ledit-tabs" role="tablist" aria-label="Partes do anúncio">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <p className="ledit-hint">{current.hint}</p>
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      {!data && !error && <div className="promo-skel" aria-hidden="true" />}
      {data && (
        <div role="tabpanel">
          {tab === 'description' && <DescriptionTab data={data} canManage={canManage} onSaved={onSaved} />}
          {tab === 'pictures' && <PicturesTab data={data} canManage={canManage} onSaved={onSaved} />}
          {tab === 'attributes' && <AttributesTab data={data} canManage={canManage} onSaved={onSaved} />}
          {tab === 'dimensions' && <DimensionsTab data={data} canManage={canManage} onSaved={onSaved} />}
          {tab === 'wholesale' && <WholesaleTab data={data} canManage={canManage} onSaved={onSaved} />}
          {tab === 'flex' && <FlexTab data={data} canManage={canManage} onSaved={onSaved} />}
        </div>
      )}
    </div>
  );
}

interface TabProps {
  data: ListingEditorDto;
  canManage: boolean;
  onSaved: (msg: string) => void;
}

/** Rodapé padrão: erro + botão salvar. */
function SaveBar({ saving, error, disabled, onSave, label = 'Salvar no Mercado Livre', note }: { saving: boolean; error: string; disabled?: boolean; onSave: () => void; label?: string; note?: ReactNode }) {
  return (
    <div className="ledit-save">
      {note && <p className="lprice-note">{note}</p>}
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      <Button type="button" loading={saving} disabled={disabled} onClick={onSave}>{label}</Button>
    </div>
  );
}

function useSave(onSaved: (msg: string) => void) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>, ok: string, fail: string) => {
    setSaving(true);
    setError('');
    try {
      await fn();
      onSaved(ok);
    } catch (err) {
      setError(errMsg(err, fail));
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, run };
}

function DescriptionTab({ data, canManage, onSaved }: TabProps) {
  const [text, setText] = useState(data.description ?? '');
  const { saving, error, run } = useSave(onSaved);
  const changed = text !== (data.description ?? '');
  return (
    <>
      <textarea className="ledit-text" value={text} disabled={!canManage} onChange={(e) => setText(e.target.value)} rows={14} aria-label="Descrição" />
      <p className="ledit-count">{text.length.toLocaleString('pt-BR')} caracteres</p>
      {canManage && (
        <SaveBar
          saving={saving}
          error={error}
          disabled={!changed}
          onSave={() => void run(() => listingsApi.setDescription(data.id, text), 'Descrição atualizada no Mercado Livre.', 'Não foi possível salvar a descrição.')}
        />
      )}
    </>
  );
}

const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

function PicturesTab({ data, canManage, onSaved }: TabProps) {
  const [pics, setPics] = useState(data.pictures);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState('');
  const { saving, error, run } = useSave(onSaved);
  const changed = pics.map((p) => p.id).join() !== data.pictures.map((p) => p.id).join();

  const move = (i: number, to: number) =>
    setPics((prev) => {
      const next = [...prev];
      [next[i], next[to]] = [next[to]!, next[i]!];
      return next;
    });

  async function add(files: FileList | null) {
    if (!files) return;
    setUploadError('');
    for (const file of Array.from(files)) {
      if (pics.length + uploading >= 12) {
        setUploadError('O Mercado Livre aceita até 12 fotos.');
        break;
      }
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        setUploadError(`${file.name}: use JPG, PNG ou WEBP.`);
        continue;
      }
      if (file.size > 10 * 1024 * 1024) {
        setUploadError(`${file.name}: acima de 10 MB.`);
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const up = await listingsApi.uploadPicture(data.id, { name: file.name, type: file.type, data: await readBase64(file) });
        setPics((prev) => [...prev, { id: up.id, url: up.url ?? URL.createObjectURL(file) }]);
      } catch (err) {
        setUploadError(errMsg(err, `Não foi possível enviar ${file.name}.`));
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  return (
    <>
      <ul className="ledit-pics">
        {pics.map((p, i) => (
          <li key={p.id}>
            <img src={p.url} alt={`Foto ${i + 1}`} loading="lazy" referrerPolicy="no-referrer" />
            {i === 0 && <span className="tag tag-active">Capa</span>}
            {canManage && (
              <div className="ledit-pic-actions">
                <button type="button" className="mini" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label="Mover para antes">‹</button>
                <button type="button" className="mini" disabled={i === pics.length - 1} onClick={() => move(i, i + 1)} aria-label="Mover para depois">›</button>
                <button type="button" className="mini mini-danger" disabled={pics.length === 1} onClick={() => setPics((prev) => prev.filter((x) => x.id !== p.id))} aria-label="Remover foto">×</button>
              </div>
            )}
          </li>
        ))}
        {uploading > 0 && Array.from({ length: uploading }, (_, i) => <li key={`up-${i}`} className="ledit-pic-loading" aria-label="Enviando foto" />)}
        {canManage && pics.length + uploading < 12 && (
          <li>
            <label className="ledit-pic-add">
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => void add(e.target.files)} />
              <span>+ Adicionar fotos</span>
            </label>
          </li>
        )}
      </ul>
      {uploadError && <p className="banner banner-error" role="alert">{uploadError}</p>}
      {canManage && (
        <SaveBar
          saving={saving}
          error={error}
          disabled={!changed || uploading > 0}
          note="Fotos novas só entram no anúncio depois de salvar."
          onSave={() => void run(() => listingsApi.setPictures(data.id, pics.map((p) => p.id)), 'Fotos atualizadas no Mercado Livre.', 'Não foi possível salvar as fotos.')}
        />
      )}
    </>
  );
}

function AttributesTab({ data, canManage, onSaved }: TabProps) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(data.attributes.map((a) => [a.id, a.value])));
  const [q, setQ] = useState('');
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  const { saving, error, run } = useSave(onSaved);
  const changed = data.attributes.filter((a) => (values[a.id] ?? '') !== a.value);
  const empty = data.attributes.filter((a) => !a.value).length;
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return data.attributes.filter((a) => (!onlyEmpty || !a.value) && (!term || a.name.toLowerCase().includes(term)));
  }, [data.attributes, q, onlyEmpty]);

  return (
    <>
      <div className="skus-toolbar">
        <label className="search">
          <span className="sr-only">Buscar campo</span>
          <input placeholder="Buscar campo (ex.: marca, modelo)" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="ledit-check">
          <input type="checkbox" checked={onlyEmpty} onChange={(e) => setOnlyEmpty(e.target.checked)} /> Só os vazios ({empty})
        </label>
      </div>
      <div className="ledit-attrs">
        {shown.map((a) => (
          <label key={a.id} className="sku-input" data-empty={!values[a.id] || undefined}>
            <small>{a.name}</small>
            <span className="sku-field">
              <input value={values[a.id] ?? ''} disabled={!canManage} onChange={(e) => setValues((v) => ({ ...v, [a.id]: e.target.value }))} />
            </span>
          </label>
        ))}
        {!shown.length && <p className="lsales-empty">Nenhum campo encontrado.</p>}
      </div>
      {canManage && (
        <SaveBar
          saving={saving}
          error={error}
          disabled={!changed.length}
          label={changed.length ? `Salvar ${changed.length} ${changed.length === 1 ? 'alteração' : 'alterações'}` : 'Salvar no Mercado Livre'}
          onSave={() =>
            void run(
              () => listingsApi.setAttributes(data.id, changed.map((a) => ({ id: a.id, value: values[a.id] ?? '' }))),
              'Ficha técnica atualizada no Mercado Livre.',
              'Não foi possível salvar a ficha técnica.',
            )
          }
        />
      )}
    </>
  );
}

function DimensionsTab({ data, canManage, onSaved }: TabProps) {
  const d0 = data.dimensions ?? { width: '', height: '', length: '', weight: '', packageType: PACKAGE_TYPES[0] };
  const [d, setD] = useState(d0);
  const { saving, error, run } = useSave(onSaved);
  const n = (s: string) => Number(s.replace(',', '.'));
  const valid = [d.width, d.height, d.length].every((v) => n(v) > 0) && Number.isInteger(n(d.weight)) && n(d.weight) > 0;

  if (data.full) {
    return (
      <div className="ledit-locked">
        <strong>Dimensões controladas pelo Mercado Livre (Full)</strong>
        <p>O galpão do ML mede o produto fisicamente. Pela API a alteração não é aplicada.</p>
        <p>Medidas atuais: <b>{data.dimensions ? `${d0.width} x ${d0.height} x ${d0.length} cm · ${d0.weight} g` : '—'}</b></p>
      </div>
    );
  }
  const field = (key: 'width' | 'height' | 'length' | 'weight', label: string, unit: string) => (
    <label className="sku-input">
      <small>{label}</small>
      <span className="sku-field">
        <input inputMode="decimal" value={d[key]} disabled={!canManage} onChange={(e) => setD({ ...d, [key]: e.target.value })} />
        <i>{unit}</i>
      </span>
    </label>
  );
  return (
    <>
      <div className="ledit-dims">
        {field('width', 'Largura', 'cm')}
        {field('height', 'Altura', 'cm')}
        {field('length', 'Comprimento', 'cm')}
        {field('weight', 'Peso', 'g')}
      </div>
      <div className="seg ledit-seg" role="radiogroup" aria-label="Embalagem">
        {PACKAGE_TYPES.map((p) => (
          <button key={p} type="button" role="radio" aria-checked={d.packageType === p} disabled={!canManage} onClick={() => setD({ ...d, packageType: p })}>{p}</button>
        ))}
      </div>
      {canManage && (
        <SaveBar
          saving={saving}
          error={error}
          disabled={!valid}
          note="Meça o pacote já embalado, como ele vai para o correio. Peso em gramas, sem casas decimais."
          onSave={() =>
            void run(
              () => listingsApi.setDimensions(data.id, { width: n(d.width), height: n(d.height), length: n(d.length), weight: n(d.weight), packageType: d.packageType }),
              'Dimensões atualizadas no Mercado Livre.',
              'Não foi possível salvar as dimensões.',
            )
          }
        />
      )}
    </>
  );
}

function WholesaleTab({ data, canManage, onSaved }: TabProps) {
  const [info, setInfo] = useState<WholesaleDto | null>(null);
  const [loadError, setLoadError] = useState('');
  const [tiers, setTiers] = useState<{ minUnits: string; price: string }[]>([]);
  const { saving, error, run } = useSave(onSaved);

  useEffect(() => {
    let alive = true;
    listingsApi
      .wholesale(data.id)
      .then((w) => {
        if (!alive) return;
        setInfo(w);
        // reconstrói as faixas a partir da amostra (o ML não lista as faixas configuradas)
        const base = w.standardPrice;
        const seen = new Set<number>();
        const guess = w.sample
          .filter((s) => s.quantity > 1 && s.price !== null && base !== null && s.price < base - 0.01)
          .filter((s) => (seen.has(s.price!) ? false : (seen.add(s.price!), true)))
          .map((s) => ({ minUnits: String(s.quantity), price: s.price!.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) }));
        setTiers(guess);
      })
      .catch((err) => alive && setLoadError(errMsg(err, 'Não foi possível ler os preços B2B.')));
    return () => {
      alive = false;
    };
  }, [data.id]);

  const parsed = tiers.map((t) => ({ minUnits: Number(t.minUnits), price: parseMoney(t.price) }));
  const base = info?.standardPrice ?? data.price ?? null;
  const invalid = parsed.some((t) => !Number.isInteger(t.minUnits) || t.minUnits < 2 || !t.price || t.price <= 0 || (base !== null && t.price >= base));

  return (
    <>
      {loadError && <p className="banner banner-error" role="alert">{loadError}</p>}
      <div className="ledit-b2b">
        <span>Preço normal: <b>{base === null ? '—' : money(base)}</b></span>
        {info && (
          <span className="ledit-b2b-sample">
            Hoje para empresa: {info.sample.map((s) => `${s.quantity} un. ${s.price === null ? '—' : money(s.price)}`).join(' · ')}
            {info.active ? ' (atacado ativo)' : ' (sem atacado)'}
          </span>
        )}
      </div>
      <ul className="ledit-tiers">
        {tiers.map((t, i) => {
          const p = parsed[i]!;
          const off = base && p.price ? 1 - p.price / base : null;
          return (
            <li key={i}>
              <span>A partir de</span>
              <span className="sku-field ledit-qty">
                <input inputMode="numeric" value={t.minUnits} disabled={!canManage} onChange={(e) => setTiers((all) => all.map((x, j) => (j === i ? { ...x, minUnits: e.target.value.replace(/\D/g, '') } : x)))} aria-label="Quantidade mínima" />
                <i>un.</i>
              </span>
              <span>pagam</span>
              <span className="sku-field ledit-tier-price">
                <i>R$</i>
                <input inputMode="decimal" value={t.price} disabled={!canManage} onChange={(e) => setTiers((all) => all.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} aria-label="Preço unitário" />
              </span>
              <small>{off !== null && off > 0 ? `${Math.round(off * 100)}% off` : ''}</small>
              {canManage && <button type="button" className="mini mini-danger" onClick={() => setTiers((all) => all.filter((_, j) => j !== i))} aria-label="Remover faixa">×</button>}
            </li>
          );
        })}
        {!tiers.length && <li className="lsales-empty">Sem faixas. Adicione uma para dar desconto por quantidade.</li>}
      </ul>
      {canManage && tiers.length < 5 && (
        <button type="button" className="act" onClick={() => setTiers((all) => [...all, { minUnits: '', price: '' }])}>+ Adicionar faixa</button>
      )}
      {canManage && (
        <SaveBar
          saving={saving}
          error={error}
          disabled={invalid || !info}
          label={tiers.length ? 'Salvar faixas' : 'Remover atacado'}
          note="O preço da faixa precisa ser menor que o normal. O ML leva alguns segundos para aplicar; conferimos antes de confirmar. Anúncios em promoção podem recusar."
          onSave={() =>
            void run(
              () => listingsApi.setWholesale(data.id, parsed.map((t) => ({ minUnits: t.minUnits, price: t.price! }))),
              tiers.length ? 'Atacado B2B aplicado no Mercado Livre.' : 'Atacado B2B removido.',
              'Não foi possível salvar o atacado.',
            )
          }
        />
      )}
    </>
  );
}

function FlexTab({ data, canManage, onSaved }: TabProps) {
  const initial = data.logistic === 'flex' || data.shippingTags.includes('self_service_in');
  const [on, setOn] = useState(initial);
  const [status, setStatus] = useState<FlexStatusDto | null>(null);
  const [loadError, setLoadError] = useState('');
  const { saving, error, run } = useSave(onSaved);

  useEffect(() => {
    listingsApi
      .flexStatus()
      .then(setStatus)
      .catch((err) => setLoadError(errMsg(err, 'Não foi possível ler sua configuração de Flex.')));
  }, []);

  const acc = status?.accounts[0];
  const accountReady = Boolean(acc?.active);

  return (
    <div className="lflex">
      <div className="lflex-toggle" data-on={on || undefined}>
        <div>
          <strong>{on ? 'Flex ativo neste anúncio' : 'Flex desligado neste anúncio'}</strong>
          <p>
            {on
              ? 'Compradores dentro da sua área veem entrega no mesmo dia (ou no dia seguinte) e você faz a entrega.'
              : 'Ative para oferecer entrega rápida feita por você para quem compra dentro da sua área.'}
            {data.full && ' Funciona junto com o Full: o ML escolhe a opção mais rápida para cada comprador.'}
          </p>
        </div>
        {canManage && (
          <Button
            type="button"
            variant={on ? 'ghost' : 'primary'}
            loading={saving}
            disabled={!on && status !== null && !accountReady}
            onClick={() =>
              void run(
                async () => {
                  await listingsApi.setFlex(data.id, !on);
                  setOn(!on);
                },
                on ? 'Flex desativado no anúncio.' : 'Flex ativado no anúncio.',
                'Não foi possível mudar o Flex.',
              )
            }
          >
            {on ? 'Desativar Flex' : 'Ativar Flex'}
          </Button>
        )}
      </div>
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      {loadError && <p className="banner banner-error" role="alert">{loadError}</p>}

      {status && !status.accounts.length && (
        <div className="ledit-locked">
          <strong>Sua conta ainda não usa Flex</strong>
          <p>Para ativar nos anúncios, primeiro habilite o Flex na conta do Mercado Livre (endereço de coleta dentro da área atendida, reputação amarela ou verde).</p>
          <a className="act" href="https://www.mercadolivre.com.br/envios/flex" target="_blank" rel="noreferrer">Configurar Flex no ML</a>
        </div>
      )}
      {acc && (
        <div className="lflex-account">
          <div>
            <small>Conta</small>
            <b>{acc.account}</b>
            <span>{acc.active ? 'Flex ativo' : `Flex ${acc.status}`}{acc.origin?.city ? ` · sai de ${acc.origin.city}` : ''}</span>
          </div>
          <div>
            <small>Sua área</small>
            <b>
              {acc.coverage?.type === 'radius'
                ? `Raio de ${acc.coverage.radiusKm.toLocaleString('pt-BR')} km`
                : acc.coverage?.zones.length
                  ? acc.coverage.zones.map((z) => z.label).join(', ')
                  : '—'}
            </b>
            <span>configurada no Mercado Livre</span>
          </div>
          {acc.pricing.length > 0 && (
            <div>
              <small>O ML te paga por entrega</small>
              <b>{acc.pricing.map((p) => `${money(p.price)} ${p.toKg ? `até ${p.toKg.toLocaleString('pt-BR')} kg` : `acima de ${p.fromKg?.toLocaleString('pt-BR')} kg`}`).join(' · ')}</b>
              <span>por faixa de peso</span>
            </div>
          )}
        </div>
      )}
      <p className="lprice-note">
        A área de entrega (zonas ou raio) e os horários são configurados na conta do ML. Veja quais anúncios mais vendem dentro da sua área em
        Anúncios → Oportunidades de Flex.
      </p>
    </div>
  );
}
