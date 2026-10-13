import { useEffect, useState, type FormEvent } from 'react';
import type { CategoryOptionDto, ListingDto } from '@nvs/shared';
import { ApiError } from '../../shared/http';
import { Button } from '../../shared/ui/Button';
import { listingsApi } from './listings-api';

/** Duplica o anúncio: mesma categoria ou outra (para testar onde vende mais). A cópia nasce pausada. */
export function DuplicateModal({ item, onDone }: { item: ListingDto; onDone: (msg: string) => void }) {
  const [title, setTitle] = useState(item.title);
  const [mode, setMode] = useState<'same' | 'other'>('same');
  const [q, setQ] = useState('');
  const [cats, setCats] = useState<CategoryOptionDto[] | null>(null);
  const [category, setCategory] = useState<CategoryOptionDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (mode !== 'other' || q.trim().length < 2) return;
    const t = window.setTimeout(() => {
      listingsApi
        .categories(item.id, q.trim())
        .then(setCats)
        .catch(() => setCats([]));
    }, 400);
    return () => window.clearTimeout(t);
  }, [q, mode, item.id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const r = await listingsApi.duplicate(item.id, {
        title: title.trim() !== item.title ? title.trim() : undefined,
        categoryId: mode === 'other' ? category?.id : undefined,
      });
      onDone(`Cópia criada (${r.id}) e pausada. Revise e reative na aba Pausados.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível duplicar.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="ledit" onSubmit={submit}>
      <header className="ledit-head">
        <h2>Duplicar anúncio</h2>
        <p className="lprice-sub">{item.title}</p>
      </header>
      <p className="ledit-hint">
        Cria um anúncio novo com fotos, ficha técnica, descrição, preço e frete deste. Ele nasce <b>pausado</b> para você revisar.
        Códigos como EAN e o SKU não são copiados (o ML recusa duplicados). Anúncio Full vira envio normal na cópia.
      </p>
      <label className="sku-input">
        <small>Título da cópia</small>
        <span className="sku-field"><input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></span>
      </label>
      <div className="seg ledit-seg" role="radiogroup" aria-label="Categoria">
        <button type="button" role="radio" aria-checked={mode === 'same'} onClick={() => setMode('same')}>Mesma categoria</button>
        <button type="button" role="radio" aria-checked={mode === 'other'} onClick={() => setMode('other')}>Outra categoria</button>
      </div>
      {mode === 'other' && (
        <>
          <label className="search">
            <span className="sr-only">Buscar categoria</span>
            <input placeholder="Digite o que é o produto (ex.: viseira capacete)" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <ul className="lcats">
            {cats?.map((c) => (
              <li key={c.id}>
                <button type="button" aria-pressed={category?.id === c.id} onClick={() => setCategory(c)}>
                  <strong>{c.name}</strong>
                  <small>{c.domain ?? ''} · {c.id}</small>
                </button>
              </li>
            ))}
            {cats && !cats.length && <li className="lsales-empty">Nenhuma categoria sugerida. Tente outras palavras.</li>}
          </ul>
        </>
      )}
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      <div className="ledit-save">
        <Button type="submit" loading={saving} disabled={title.trim().length < 3 || (mode === 'other' && !category)}>
          Criar cópia pausada
        </Button>
      </div>
    </form>
  );
}
