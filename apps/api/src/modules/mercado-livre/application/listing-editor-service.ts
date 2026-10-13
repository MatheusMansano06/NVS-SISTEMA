import type { ListingEditorDto, WholesaleDto } from '@nvs/shared';
import { AppError } from '../../../shared/kernel/errors.js';
import { logisticOf } from '../domain/listing-margin.js';
import type { MlApi, MlItemFull } from '../infrastructure/ml-api.js';
import { toNumber } from '../infrastructure/pg-listing-repository.js';
import type { ListingService } from './listing-service.js';
import type { MlIntegrationService } from './ml-integration-service.js';

const PACKAGE = {
  width: 'SELLER_PACKAGE_WIDTH',
  height: 'SELLER_PACKAGE_HEIGHT',
  length: 'SELLER_PACKAGE_LENGTH',
  weight: 'SELLER_PACKAGE_WEIGHT',
  type: 'SELLER_PACKAGE_TYPE',
} as const;
const SAMPLE_QUANTITIES = [1, 5, 10, 25];
const B2B_RESTRICTIONS = ['channel_marketplace', 'user_type_business'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class NotApplied extends AppError {
  constructor(message: string) {
    super(message, 'NOT_APPLIED', 409);
  }
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Assinatura dos formatos aceitos (o tipo informado pelo navegador não basta). */
export function imageKind(b: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Base64 válido, até 10 MB, e conteúdo que é mesmo uma imagem do tipo informado. */
export function decodeImage(type: string, data: string): Buffer {
  if (data.length % 4 !== 0 || !BASE64.test(data)) throw new AppError('Arquivo inválido.', 'VALIDATION_ERROR', 400);
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > 10 * 1024 * 1024) throw new AppError('Imagem acima de 10 MB.', 'VALIDATION_ERROR', 400);
  const kind = imageKind(bytes);
  if (!kind) throw new AppError('O arquivo não é uma imagem JPG, PNG ou WEBP.', 'VALIDATION_ERROR', 400);
  if (kind !== type) throw new AppError('O conteúdo do arquivo não bate com o tipo informado.', 'VALIDATION_ERROR', 400);
  return bytes;
}

/** Primeiro número de "28 cm" / "1880 g". */
export const firstNumber = (s: string | null | undefined): number | null => {
  const n = Number(String(s ?? '').replace(',', '.').split(/\s+/)[0]);
  return Number.isFinite(n) && String(s ?? '').trim() ? n : null;
};

type Attr = NonNullable<MlItemFull['attributes']>[number];

/**
 * Junta os atributos atuais com as alterações. O ML exige reenviar a lista inteira; atributos não
 * alterados mantêm o value_id (lista fechada) ou o value_name.
 */
export function mergeAttributes(current: Attr[], updates: Record<string, string>) {
  const out: { id: string; value_id?: string; value_name?: string | null }[] = [];
  const seen = new Set<string>();
  for (const a of current) {
    seen.add(a.id);
    if (a.id in updates) out.push({ id: a.id, value_name: updates[a.id] || null });
    else if (a.value_id) out.push({ id: a.id, value_id: a.value_id });
    else if (a.value_name != null) out.push({ id: a.id, value_name: a.value_name });
  }
  for (const [id, value] of Object.entries(updates)) if (!seen.has(id)) out.push({ id, value_name: value || null });
  return out;
}

/** Editor do anúncio: descrição, fotos, ficha técnica, dimensões e preços de atacado (B2B). */
export class ListingEditorService {
  constructor(
    private readonly listings: ListingService,
    private readonly ml: MlIntegrationService,
    private readonly api: MlApi,
  ) {}

  async get(tenantId: string, id: string): Promise<ListingEditorDto> {
    const { row, token } = await this.listings.session(tenantId, id);
    const [item, description] = await Promise.all([
      this.listings.wrap(() => this.api.itemFull(token, id)),
      this.listings.wrap(() => this.api.description(token, id)),
    ]);
    const attrs = item.attributes ?? [];
    const value = (key: string) => attrs.find((a) => a.id === key)?.value_name ?? '';
    const hasPackage = attrs.some((a) => a.id.startsWith('SELLER_PACKAGE_'));
    const logistic = item.shipping?.logistic_type ?? row.logistic_type;
    return {
      id,
      title: item.title,
      sku: row.sku,
      price: item.price ?? toNumber(row.price),
      pictureUrl: row.picture_url,
      permalink: row.permalink,
      logistic: logisticOf(logistic ?? null),
      full: logistic === 'fulfillment',
      catalog: Boolean(item.catalog_listing),
      description,
      attributes: attrs
        .filter((a) => !a.id.startsWith('SELLER_PACKAGE_'))
        .map((a) => ({ id: a.id, name: a.name || a.id, value: a.value_name ?? '' })),
      pictures: (item.pictures ?? []).map((p) => ({ id: p.id, url: (p.secure_url ?? p.url ?? '').replace(/^http:/, 'https:') })),
      dimensions: hasPackage
        ? {
            width: String(firstNumber(value(PACKAGE.width)) ?? ''),
            height: String(firstNumber(value(PACKAGE.height)) ?? ''),
            length: String(firstNumber(value(PACKAGE.length)) ?? ''),
            weight: String(firstNumber(value(PACKAGE.weight)) ?? ''),
            packageType: value(PACKAGE.type) || 'Com embalagem adicional',
          }
        : null,
      shippingTags: item.shipping?.tags ?? [],
    };
  }

  async setDescription(tenantId: string, id: string, text: string) {
    const { token } = await this.listings.session(tenantId, id);
    await this.listings.wrap(() => this.api.setDescription(token, id, text));
    return { ok: true as const };
  }

  async setAttributes(tenantId: string, id: string, attributes: { id: string; value: string }[]) {
    const { token, connectionId } = await this.listings.session(tenantId, id);
    const item = await this.listings.wrap(() => this.api.itemFull(token, id));
    const updates = Object.fromEntries(
      attributes.filter((a) => !a.id.startsWith('SELLER_PACKAGE_')).map((a) => [a.id, a.value]),
    );
    // só reenvia se algo mudou
    const current = new Map((item.attributes ?? []).map((a) => [a.id, a.value_name ?? '']));
    const changed = Object.entries(updates).filter(([k, v]) => (current.get(k) ?? '') !== v);
    if (!changed.length) return { ok: true as const, changed: 0 };
    await this.listings.wrap(() =>
      this.api.updateItem(token, id, { attributes: mergeAttributes(item.attributes ?? [], Object.fromEntries(changed)) }),
    );
    await this.ml.refreshListings(tenantId, connectionId, [id]);
    return { ok: true as const, changed: changed.length };
  }

  async setDimensions(
    tenantId: string,
    id: string,
    d: { width: number; height: number; length: number; weight: number; packageType: string },
  ) {
    const { token, connectionId } = await this.listings.session(tenantId, id);
    const item = await this.listings.wrap(() => this.api.itemFull(token, id));
    if (item.shipping?.logistic_type === 'fulfillment') {
      throw new NotApplied('Anúncio Full: o galpão do Mercado Livre mede o produto e as dimensões não podem ser alteradas.');
    }
    const updates = {
      [PACKAGE.width]: `${d.width} cm`,
      [PACKAGE.height]: `${d.height} cm`,
      [PACKAGE.length]: `${d.length} cm`,
      [PACKAGE.weight]: `${d.weight} g`,
      [PACKAGE.type]: d.packageType,
    };
    await this.listings.wrap(() => this.api.updateItem(token, id, { attributes: mergeAttributes(item.attributes ?? [], updates) }));
    // o ML pode responder 200 sem aplicar: confere relendo
    const after = await this.listings.wrap(() => this.api.itemFull(token, id));
    const got = (k: string) => firstNumber(after.attributes?.find((a) => a.id === k)?.value_name);
    const ok =
      got(PACKAGE.width) === d.width && got(PACKAGE.height) === d.height &&
      got(PACKAGE.length) === d.length && got(PACKAGE.weight) === d.weight;
    if (!ok) throw new NotApplied('O Mercado Livre não aplicou as dimensões neste anúncio.');
    await this.ml.refreshListings(tenantId, connectionId, [id]);
    return { ok: true as const };
  }

  async setPictures(tenantId: string, id: string, pictureIds: string[]) {
    const { token, connectionId } = await this.listings.session(tenantId, id);
    await this.listings.wrap(() => this.api.updateItem(token, id, { pictures: pictureIds.map((p) => ({ id: p })) }));
    await this.ml.refreshListings(tenantId, connectionId, [id]);
    return { ok: true as const };
  }

  async uploadPicture(tenantId: string, id: string, file: { name: string; type: string; data: string }) {
    const bytes = decodeImage(file.type, file.data);
    const { token } = await this.listings.session(tenantId, id);
    return this.listings.wrap(() => this.api.uploadPicture(token, { name: file.name, type: file.type, bytes }));
  }

  async wholesale(tenantId: string, id: string): Promise<WholesaleDto> {
    const { token } = await this.listings.session(tenantId, id);
    const prices = await this.listings.wrap(() => this.api.prices(token, id));
    const standard = prices.find((p) => p.type === 'standard');
    const sample = await Promise.all(
      SAMPLE_QUANTITIES.map(async (quantity) => ({ quantity, price: await this.api.businessPrice(token, id, quantity).catch(() => null) })),
    );
    const base = standard?.amount ?? null;
    return {
      standardPrice: base,
      sample,
      active: base !== null && sample.some((s) => s.price !== null && s.price < base - 0.01),
    };
  }

  /**
   * Faixas B2B por quantidade. O ML responde 200 mesmo quando não aplica (ex.: anúncio em promoção),
   * e a aplicação é assíncrona: confere o preço B2B de cada faixa algumas vezes antes de concluir.
   */
  async setWholesale(tenantId: string, id: string, tiers: { minUnits: number; price: number }[], waitMs = 2000) {
    const { token } = await this.listings.session(tenantId, id);
    const prices = await this.listings.wrap(() => this.api.prices(token, id));
    const standard = prices.find((p) => p.type === 'standard');
    if (!standard) throw new NotApplied('Preço padrão não encontrado neste anúncio.');
    const currency = standard.currency_id ?? 'BRL';
    const unique = [...new Map(tiers.map((t) => [t.minUnits, t])).values()].sort((a, b) => a.minUnits - b.minUnits);
    await this.listings.wrap(() =>
      this.api.setQuantityPrices(token, id, [
        { id: standard.id },
        ...unique.map((t) => ({
          amount: t.price,
          currency_id: currency,
          conditions: { context_restrictions: B2B_RESTRICTIONS, min_purchase_unit: t.minUnits },
        })),
      ]),
    );
    const pending = new Map(unique.map((t) => [t.minUnits, t.price]));
    for (let round = 0; round < 5 && pending.size; round++) {
      if (round) await sleep(waitMs);
      for (const [qty, expected] of [...pending]) {
        const got = await this.api.businessPrice(token, id, qty).catch(() => null);
        if (got !== null && Math.abs(got - expected) <= 0.01) pending.delete(qty);
      }
    }
    if (pending.size) {
      throw new NotApplied(
        'O Mercado Livre não aplicou as faixas de atacado. Costuma acontecer quando o anúncio tem uma promoção ativa que conflita com preço por quantidade.',
      );
    }
    return { ok: true as const, tiers: unique.length };
  }
}
