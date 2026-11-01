/** Read-only Shop discovery through the existing MCP transport.
 * This never pays, edits catalog records, or grants merchant authority. */
import { mcpResource } from '@red-cup-engineering/mcp-engineering-services-section/http';
import { filterStorefrontItems } from '@red-cup-engineering/web-page-tiling-engine/storefront';

const MAX_RESULTS = 40;
const MAX_OFFSET = 10_000;
const STATUSES = new Set(['live', 'test-only', 'coming-soon', 'external']);
const readonly = Object.freeze({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });

/** Search the original seller's privacy-filtered catalog with TUFTE's own text
 * selector; do not make another global Shop registry or infer a purchase. */
export function selectShopProducts(publicCatalog, {
  mode = 'list', id, query = '', status, purchasableOnly = false,
  offset = 0, limit = 20, origin, goodsPath = '/goods/',
} = {}) {
  if (!publicCatalog || typeof publicCatalog.merchant?.name !== 'string' ||
      !Array.isArray(publicCatalog.offerings))
    throw new TypeError('Shop discovery requires a seller-authored public catalog');
  if (typeof origin !== 'string') throw new TypeError('Shop origin must be HTTPS');
  const base = new URL(origin);
  if (base.origin !== origin || base.protocol !== 'https:' || base.username || base.password)
    throw new TypeError('Shop origin must be a canonical HTTPS origin');
  if (typeof goodsPath !== 'string' || !/^\/(?:[a-zA-Z0-9_-]+\/)*$/u.test(goodsPath))
    throw new TypeError('Shop products need an absolute canonical goods prefix');
  if (!['list', 'search', 'get'].includes(mode)) throw new TypeError('unknown Shop discovery operation');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS)
    throw new RangeError('Shop discovery needs bounded offset and limit');
  if (typeof query !== 'string' || query.length > 160 ||
      (mode === 'search' && query.trim().length === 0))
    throw new TypeError('Shop search needs a bounded nonempty query');
  if (status !== undefined && !STATUSES.has(status)) throw new TypeError('invalid Shop status filter');
  if (typeof purchasableOnly !== 'boolean') throw new TypeError('purchasableOnly must be Boolean');
  if (mode === 'get' && (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)))
    throw new TypeError('get_product requires an exact Shop product id');

  const original = publicCatalog.offerings;
  const productUrl = product => new URL(goodsPath + encodeURIComponent(product.id), origin).href;
  const present = product => Object.freeze({ ...product, url: productUrl(product) });
  if (mode === 'get') {
    const product = original.find(product => product.id === id);
    return product ? present(product) : null;
  }
  const indexed = original.map(product => ({
    id: product.id, title: product.title ?? product.id,
    summary: product.blurb ?? product.subtitle ?? '', keywords: product.keywords ?? [],
  }));
  const matches = filterStorefrontItems({ items: indexed }, {
    term: mode === 'search' ? query.trim() : '', facets: {},
  });
  const matched = new Set(matches.map(product => product.id));
  const filtered = original.filter(product => matched.has(product.id) &&
    (status === undefined || product.status === status) &&
    (!purchasableOnly || product.buyable === true));
  return Object.freeze({
    merchant: publicCatalog.merchant,
    sourceUrl: new URL('/catalog.json', origin).href,
    total: filtered.length, offset, limit,
    products: Object.freeze(filtered.slice(offset, offset + limit).map(present)),
    nextOffset: offset + limit < filtered.length ? offset + limit : null,
    paymentAuthorization: 'not granted by read-only discovery',
  });
}

/** MCP is the existing shared Networking implementation. The installed Shop
 * supplies exactly the same per-request public catalog as its HTTP reader. */
export function createShopMcpEndpoint({
  origin, goodsPath = '/goods/', sellerName, readPublicCatalog, path = '/mcp',
} = {}) {
  if (typeof sellerName !== 'string' || !sellerName || typeof readPublicCatalog !== 'function')
    throw new TypeError('Shop MCP needs seller identity and source readout');
  const tools = [
    {
      name: 'list_products', title: 'List Shop products',
      description: 'Browse seller-authored products and present card checkout availability. Listing is not permission to purchase.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        status: { type: 'string', enum: [...STATUSES] }, purchasableOnly: { type: 'boolean' },
        offset: { type: 'integer', minimum: 0, maximum: MAX_OFFSET },
        limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS },
      } }, annotations: readonly,
      handler: (args, context) => selectShopProducts(context.shopCatalog(), {
        ...args, mode: 'list', origin, goodsPath,
      }),
    },
    {
      name: 'search_products', title: 'Search Shop products',
      description: 'Match public products using the human Shop text search. No payment or merchant authority.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        query: { type: 'string', minLength: 1, maxLength: 160 },
        status: { type: 'string', enum: [...STATUSES] }, purchasableOnly: { type: 'boolean' },
        offset: { type: 'integer', minimum: 0, maximum: MAX_OFFSET },
        limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS },
      }, required: ['query'] }, annotations: readonly,
      handler: (args, context) => selectShopProducts(context.shopCatalog(), {
        ...args, mode: 'search', origin, goodsPath,
      }),
    },
    {
      name: 'get_product', title: 'Inspect a Shop product',
      description: 'Read one public product, accepted edition hashes, seller URL and purchase availability. Does not initiate checkout.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
      }, required: ['id'] }, annotations: readonly,
      handler: (args, context) => selectShopProducts(context.shopCatalog(), {
        ...args, mode: 'get', origin, goodsPath,
      }) ?? { isError: true, content: [{ type: 'text', text: 'No public product has that exact ID' }] },
    },
  ];
  return mcpResource({
    name: sellerName + ' Shop', version: '1.0.0', path, tools,
    maxBodyBytes: 32_768,
    modern: { supportedVersions: ['2026-07-28', '2025-06-18'],
      exactOrigin: true, ttlMs: 60_000, cacheScope: 'public' },
    bind: ({ ctx }) => ({ shopCatalog: () => readPublicCatalog(ctx) }),
  });
}
