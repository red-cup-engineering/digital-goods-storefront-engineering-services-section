import assert from 'node:assert/strict';
import test from 'node:test';
import { createShopMcpEndpoint, selectShopProducts } from '../src/shop-mcp.mjs';

const origin = 'https://shop.561.group';
const source = Object.freeze({
  merchant: { name: 'Test Press', legalBody: 'test-press' },
  offerings: [
    { id: 'the-x402-economy', title: 'The x402 Economy', blurb: 'One HTTP payment guide',
      keywords: ['x402', 'payments'], status: 'live', buyable: false,
      priceCents: 900, currency: 'usd',
      agentOfferUrl: 'https://market.561.group/#publications-the-x402-economy',
      book: { edition: { files: [{ format: 'EPUB', sha256: 'a'.repeat(64) }] } } },
    { id: 'math-book', title: 'Math Book', blurb: 'Relational mathematics',
      keywords: ['logic'], status: 'live', buyable: true, priceCents: 1200, currency: 'usd' },
    { id: 'coming-soon', title: 'Future Title', status: 'coming-soon', buyable: false },
  ],
});
function endpoint() {
  return createShopMcpEndpoint({
    origin, sellerName: 'Test Press',
    readPublicCatalog: ({ env }) => ({
      ...source, offerings: source.offerings.map(product => ({
        ...product, buyable: env?.checkoutArmed === true && product.status === 'live',
      })),
    }),
  });
}
const rpc = (method, params) => ({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) });
async function send(endpoint, payload, env = {}, extraHeaders = {}) {
  return endpoint.handler({
    request: new Request(origin + '/mcp', { method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(payload) }), env,
  });
}

test('Shop product selection preserves original source price, edition and links', () => {
  const result = selectShopProducts(source, { origin, mode: 'search', query: 'X402' });
  assert.deepEqual(result.products.map(product => product.id), ['the-x402-economy']);
  assert.equal(result.products[0].url, origin + '/goods/the-x402-economy');
  assert.equal(result.products[0].agentOfferUrl, 'https://market.561.group/#publications-the-x402-economy');
  assert.equal(result.products[0].book.edition.files[0].sha256, 'a'.repeat(64));
  assert.equal(result.products[0].buyable, false);
  assert.deepEqual(selectShopProducts(source, { origin, purchasableOnly: true }).products.map(p => p.id), ['math-book']);
  assert.equal(selectShopProducts(source, { origin, mode: 'get', id: 'unrecognized' }), null);
  assert.throws(() => selectShopProducts(source, { origin, limit: 41 }), RangeError);
  assert.throws(() => selectShopProducts(source, { origin, mode: 'search', query: ' ' }), TypeError);
  assert.throws(() => selectShopProducts(source, { origin, mode: 'get', id: '../secret' }), TypeError);
  assert.throws(() => selectShopProducts(source, { origin: 'http://shop.561.group' }), TypeError);
});

test('original MCP transport serves bounded read-only Shop discovery', async () => {
  const resource = endpoint();
  const listed = await send(resource, rpc('tools/list'));
  assert.equal(listed.status, 200);
  const advertised = (await listed.json()).result.tools;
  assert.deepEqual(advertised.map(tool => tool.name), ['list_products', 'search_products', 'get_product']);
  assert.ok(advertised.every(tool => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
  const call = (name, args, env) => send(resource, rpc('tools/call', { name, arguments: args }), env);
  const unarmed = (await (await call('list_products', { purchasableOnly: true }, {})).json()).result.structuredContent;
  assert.equal(unarmed.total, 0);
  const armed = (await (await call('list_products', { purchasableOnly: true }, { checkoutArmed: true })).json()).result.structuredContent;
  assert.equal(armed.total, 2);
  const found = (await (await call('search_products', { query: 'MATH' }, { checkoutArmed: true })).json()).result.structuredContent;
  assert.deepEqual(found.products.map(product => product.id), ['math-book']);
  const exact = (await (await call('get_product', { id: 'the-x402-economy' }, {})).json()).result.structuredContent;
  assert.equal(exact.buyable, false);
  const unknown = (await (await call('get_product', { id: 'not-there' }, {})).json()).result;
  assert.equal(unknown.isError, true);
});

test('MCP refuses cross-origin invocation and invalid arguments without touching checkout', async () => {
  const resource = endpoint();
  const blocked = await send(resource, rpc('tools/call', { name: 'list_products', arguments: {} }),
    {}, { origin: 'https://attacker.example' });
  assert.equal(blocked.status, 403);
  const malformed = await send(resource, rpc('tools/call', {
    name: 'list_products', arguments: { limit: 42 },
  }));
  const answer = await malformed.json();
  assert.ok(answer.error || answer.result?.isError);
  assert.equal((await resource.handler({ request: new Request(origin + '/mcp') })).status, 405);
  assert.equal((await resource.handler({ request: new Request(origin + '/mcp', { method: 'PUT' }) })).status, 405);
});
