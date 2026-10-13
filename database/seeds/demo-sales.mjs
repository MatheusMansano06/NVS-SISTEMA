// Gera dados de DEMONSTRAÇÃO de vendas para uma conta (marcados source='demo').
// Uso: node database/seeds/demo-sales.mjs <email> [--remove]
// --remove apaga apenas os dados demo dessa conta. Determinístico (mesma semente = mesmos dados).
import pg from 'pg';

const [email, flag] = process.argv.slice(2);
if (!email || !process.env.DATABASE_URL) {
  console.error('Uso: DATABASE_URL=... node database/seeds/demo-sales.mjs <email> [--remove]');
  process.exit(1);
}

const DAYS = 120;
const PRODUCTS = [
  ['KIT-REL-CG160', 'Kit Relação Honda CG 160 Titan/Fan', 189.9, 98],
  ['PAST-FREIO-DIANT', 'Pastilha de Freio Dianteira Cobreq', 39.9, 14.5],
  ['CAP-LS2-FF358', 'Capacete LS2 FF358 Classic Preto Fosco', 549.9, 352],
  ['OLEO-MOTUL-5100', 'Óleo Motul 5100 15W50 Semissintético 1L', 54.9, 31],
  ['PNEU-PIR-100-80', 'Pneu Traseiro Pirelli Super City 100/80-18', 219.9, 141],
  ['BAT-MOURA-5AH', 'Bateria Moura MA5-D 5Ah', 249.9, 158],
  ['RETROV-CG-PAR', 'Par de Retrovisores Honda CG 2014+', 69.9, 27],
  ['VELA-NGK-CPR8', 'Vela de Ignição NGK CPR8EA-9', 29.9, 11.2],
  ['MANETE-ALU-PAR', 'Par de Manetes Alumínio Anodizado', 89.9, 36],
  ['FILTRO-AR-FAZER', 'Filtro de Ar Yamaha Fazer 250', 45.9, 18.4],
  ['BAU-GIVI-30L', 'Baú Givi Monolock 30 Litros', 399.9, 248],
  ['CAMARA-AR-18', 'Câmara de Ar Pirelli Aro 18', 34.9, 15],
  ['LUVA-X11-FIT', 'Luva X11 Fit X Masculina', 119.9, 61],
  ['CAPA-CHUVA-PVC', 'Capa de Chuva Motoqueiro PVC Conjunto', 79.9, 33],
  ['LAMP-LED-H4', 'Lâmpada Super LED H4 6000K', 99.9, 38],
  ['CABO-EMBR-CG', 'Cabo de Embreagem Honda CG 125/150', 32.9, 12.8],
  ['CORRENTE-428H', 'Corrente Reforçada 428H 118L', 74.9, 39],
  ['PROTETOR-MOTOR', 'Protetor de Motor e Carenagem CB 300', 259.9, 132],
];
// destinos e formas de pagamento (pesos aproximados de uma loja do Sudeste)
const DESTS = [['SP', 'São Paulo'], ['MG', 'Belo Horizonte'], ['RJ', 'Rio de Janeiro'], ['PR', 'Curitiba'], ['RS', 'Porto Alegre'],
  ['BA', 'Salvador'], ['SC', 'Joinville'], ['PE', 'Recife'], ['GO', 'Goiânia'], ['CE', 'Fortaleza'], ['PA', 'Belém'], ['DF', 'Brasília']];
const DEST_WEIGHTS = [30, 12, 10, 8, 6, 6, 5, 4, 4, 3, 2, 3];
const PAYS = ['account_money', 'credit_card', 'bank_transfer', 'debit_card', 'ticket'];
const PAY_WEIGHTS = [35, 32, 25, 5, 3];
// popularidade relativa (os primeiros vendem mais)
const WEIGHTS = PRODUCTS.map((_, i) => 1 / (1 + i * 0.35));

// PRNG determinístico (mulberry32)
let seed = 20261009;
const rand = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pickWeighted = (weights) => {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < weights.length; i++) if ((r -= weights[i]) <= 0) return i;
  return weights.length - 1;
};
const HOUR_WEIGHTS = [1, .5, .3, .2, .2, .4, 1, 2, 3.5, 4.5, 5, 5.2, 5, 4.6, 4.8, 5, 5, 4.6, 4.2, 4.8, 5.4, 5, 3.6, 2];
const money = (n) => Math.round(n * 100) / 100;

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const found = await client.query('SELECT tenant_id FROM login_identities WHERE email = $1', [email.toLowerCase()]);
  const tenantId = found.rows[0]?.tenant_id;
  if (!tenantId) throw new Error(`Conta ${email} não encontrada`);

  await client.query('BEGIN');
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  // sempre limpa o demo anterior (idempotente)
  await client.query("DELETE FROM orders WHERE source = 'demo'");
  await client.query("DELETE FROM listings WHERE source = 'demo'");
  await client.query("DELETE FROM marketplace_accounts WHERE source = 'demo'");

  if (flag === '--remove') {
    await client.query('COMMIT');
    console.log(`Dados de demonstração removidos de ${email}.`);
    process.exit(0);
  }

  const accounts = [];
  for (const [nickname, ext] of [['NOVAES MOTO PEÇAS', 'demo-ml-1'], ['NVS OUTLET', 'demo-ml-2']]) {
    const { rows } = await client.query(
      `INSERT INTO marketplace_accounts (tenant_id, marketplace, nickname, external_id, source)
       VALUES ($1, 'mercado_livre', $2, $3, 'demo') RETURNING id`,
      [tenantId, nickname, ext],
    );
    accounts.push(rows[0].id);
  }

  const now = new Date();
  let orderCount = 0;
  let seq = 0;
  for (let d = DAYS - 1; d >= 0; d--) {
    const day = new Date(now.getTime() - d * 86_400_000);
    const weekday = day.getUTCDay();
    const growth = 0.75 + 0.45 * ((DAYS - d) / DAYS); // tendência de crescimento
    const weekly = weekday === 0 ? 0.65 : weekday === 6 ? 0.8 : weekday === 1 ? 1.15 : 1;
    const ordersToday = Math.round((10 + rand() * 9) * growth * weekly);

    const orderRows = [];
    const itemRows = [];
    for (let k = 0; k < ordersToday; k++) {
      const hour = pickWeighted(HOUR_WEIGHTS);
      // horário local de São Paulo (UTC-3) convertido para UTC
      const at = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour + 3, Math.floor(rand() * 60)));
      if (at > now) continue;
      const itemsN = rand() < 0.75 ? 1 : rand() < 0.8 ? 2 : 3;
      let gross = 0, cost = 0, units = 0;
      const items = [];
      for (let j = 0; j < itemsN; j++) {
        const p = PRODUCTS[pickWeighted(WEIGHTS)];
        const qty = rand() < 0.85 ? 1 : 2;
        const price = money(p[2] * (0.95 + rand() * 0.1));
        items.push([p[0], p[1], qty, price, p[3], `MLB${3000000000 + PRODUCTS.indexOf(p)}`]);
        gross += qty * price; cost += qty * p[3]; units += qty;
      }
      gross = money(gross);
      const fee = money(gross * (0.115 + rand() * 0.05) + (gross < 79 ? 6.25 : 0));
      const shipping = gross >= 79 ? money(18 + rand() * 22) : 0;
      const status = rand() < 0.93 ? 'paid' : rand() < 0.7 ? 'cancelled' : 'returned';
      const id = crypto.randomUUID();
      const bucket = rand() < 0.45 ? 'full' : rand() < 0.6 ? 'places_coleta' : rand() < 0.8 ? 'flex' : 'me1';
      const dest = DESTS[pickWeighted(DEST_WEIGHTS)];
      const pay = PAYS[pickWeighted(PAY_WEIGHTS)];
      orderRows.push([id, tenantId, accounts[rand() < 0.78 ? 0 : 1], `DEMO-${++seq}`, status, at.toISOString(), gross, fee, shipping, money(cost), units, bucket,
        pay, dest[0], dest[1], `${String(10000 + Math.floor(rand() * 89999))}${String(Math.floor(rand() * 999)).padStart(3, '0')}`, `CLIENTE${1000 + Math.floor(rand() * 9000)}`]);
      for (const it of items) itemRows.push([tenantId, id, ...it]);
    }
    if (!orderRows.length) continue;

    const N = 17;
    const ov = orderRows.map((_, i) => {
      const p = (k) => `$${i * N + k}`;
      return `(${p(1)},${p(2)},${p(3)},'mercado_livre',${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},${p(11)},'demo',true,${p(12)},now(),${p(13)},${p(14)},${p(15)},${p(16)},${p(17)},now())`;
    });
    await client.query(
      `INSERT INTO orders (id, tenant_id, account_id, marketplace, external_id, status, ordered_at, gross_amount, marketplace_fee, shipping_cost, product_cost, units, source, cost_known, logistic_bucket, finance_enriched_at,
                          payment_type, ship_state, ship_city, ship_zip, buyer_nickname, address_checked_at) VALUES ${ov.join(',')}`,
      orderRows.flat(),
    );
    const iv = itemRows.map((_, i) => `($${i * 8 + 1},$${i * 8 + 2},$${i * 8 + 3},$${i * 8 + 4},$${i * 8 + 5},$${i * 8 + 6},$${i * 8 + 7},$${i * 8 + 8})`);
    await client.query(
      `INSERT INTO order_items (tenant_id, order_id, sku, title, quantity, unit_price, unit_cost, listing_id) VALUES ${iv.join(',')}`,
      itemRows.flat(),
    );
    orderCount += orderRows.length;
  }
  // catálogo: os 12 primeiros ativos; os demais pausados (4 sem estoque), sem fotos (demo)
  const LOGISTICS = ['fulfillment', 'cross_docking', 'self_service', 'xd_drop_off'];
  for (const [i, p] of PRODUCTS.entries()) {
    const paused = i >= 12;
    const outOfStock = paused && i < 16;
    await client.query(
      `INSERT INTO listings (tenant_id, account_id, marketplace, external_id, title, price, available_quantity, status, sub_status, source,
                             sku, sold_quantity, listing_type_id, free_shipping, logistic_type, pictures_count, dimensions, listed_at)
       VALUES ($1, $2, 'mercado_livre', $3, $4, $5, $6, $7, $8, 'demo', $9, $10, $11, $12, $13, $14, $15, now() - ($16 || ' days')::interval)`,
      [tenantId, accounts[i % 2], `MLB${3000000000 + i}`, p[1], p[2], outOfStock ? 0 : 6 + i * 3, paused ? 'paused' : 'active', outOfStock ? ['out_of_stock'] : [],
       p[0], Math.round(900 / (1 + i * 0.6)), i % 3 === 0 ? 'gold_pro' : 'gold_special', p[2] >= 79, LOGISTICS[i % LOGISTICS.length],
       1 + (i * 5) % 9, `${20 + i}x${10 + (i % 7)}x${8 + (i % 5)},${150 + i * 40}`, String(60 + i * 97)],
    );
  }

  // médias de tarifa/frete por anúncio (o que a sincronização faz na conta real)
  await client.query(
    `UPDATE listings l SET sales_fee_avg = x.fee, sales_freight_avg = x.freight
       FROM (SELECT l2.id, sum(o.marketplace_fee) / nullif(sum(o.units), 0) AS fee, sum(o.shipping_cost) / nullif(sum(o.units), 0) AS freight
               FROM listings l2
               LEFT JOIN order_items i ON i.listing_id = l2.external_id
               LEFT JOIN orders o ON o.id = i.order_id AND o.status = 'paid' AND o.units = i.quantity
              WHERE l2.tenant_id = $1 AND l2.source = 'demo' GROUP BY l2.id) x
      WHERE l.id = x.id`,
    [tenantId],
  );

  await client.query('COMMIT');
  console.log(`Demo criado para ${email}: ${orderCount} pedidos em ${DAYS} dias, 2 contas Mercado Livre.`);
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
