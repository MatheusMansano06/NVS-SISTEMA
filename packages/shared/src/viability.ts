/** Estudo de viabilidade de um anúncio (de qualquer vendedor) do Mercado Livre — usado pela extensão do Chrome. */
export interface ViabilityDto {
  itemId: string;
  title: string;
  permalink: string | null;
  thumbnail: string | null;
  price: number | null;
  /** Data de criação do anúncio (ISO). */
  createdAt: string | null;
  /** Dias desde a criação. */
  ageDays: number | null;
  /** Vendas informadas pelo ML (pode vir arredondada ou ausente para anúncio de terceiro). */
  soldQuantity: number | null;
  /** Média de vendas por dia de vida. */
  salesPerDay: number | null;
  /** true = anúncio de catálogo; false = tradicional. */
  catalog: boolean | null;
  /** Clássico / Premium / outro (rótulo). */
  listingType: string | null;
  freeShipping: boolean | null;
  /** Fulfillment (Full), Flex etc. */
  logisticType: string | null;
  availableQuantity: number | null;
  seller: { id: number; nickname: string | null; reputation: string | null } | null;
  /** Visitas dos últimos ~6 meses. */
  visits: {
    total: number;
    daily: { date: string; total: number }[];
    monthly: { month: string; total: number }[];
  } | null;
  /** Dados que o ML não liberou para este anúncio (ex.: "visitas"). */
  unavailable: string[];
  fetchedAt: string;
}
