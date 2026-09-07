/**
 * services/customerCatalogService.js — Customer Product Ordering module.
 *
 * Every rule from spec sections 6-17 (price source, online vs. actual
 * stock, min/max/step, stock visibility, backorder) lives in ONE place:
 * resolveProductForCustomer(). The catalog list, product detail, cart,
 * and checkout all call this same function rather than each
 * re-implementing "what price/availability does this customer see" —
 * exactly the "do not create a second competing pricing engine" /
 * "reuse existing calculation" instructions, applied to this module's
 * own internals as much as to the rest of the codebase.
 */
const db = require('../db/knex')

/** Actual physical stock per product — the exact SUM(qty_remaining)
 *  pattern already used by routes/stock.js, not a second stock
 *  calculation invented for this module. */
async function getActualStockMap(companyId, productIds) {
  if (!productIds.length) return new Map()
  const rows = await db('inventory_batches')
    .where({ company_id: companyId })
    .whereIn('product_id', productIds)
    .groupBy('product_id')
    .select('product_id')
    .sum('qty_remaining as stock')
  return new Map(rows.map(r => [r.product_id, Number(r.stock) || 0]))
}

/**
 * "Reserved" (spec section 9) — quantity already committed to OTHER open
 * customer orders for this product, not yet converted to a Sale (and so
 * not yet reflected in inventory_batches at all — see migration 034's
 * docblock on why orders don't touch physical stock). Subtracting this
 * from online-sellable quantity is what lets two concurrent customers
 * see accurate, shrinking availability in real time even though nothing
 * has actually been deducted from stock yet.
 */
async function getReservedQtyMap(companyId, productIds) {
  if (!productIds.length) return new Map()
  const rows = await db('customer_order_items as coi')
    .join('customer_orders as co', 'co.id', 'coi.order_id')
    .where('co.company_id', companyId)
    .whereIn('co.status', ['pending', 'confirmed', 'processing', 'ready'])
    .whereIn('coi.product_id', productIds)
    .groupBy('coi.product_id')
    .select('coi.product_id')
    .sum('coi.quantity as reserved')
  return new Map(rows.map(r => [r.product_id, Number(r.reserved) || 0]))
}

/**
 * The single source of truth for "what can this customer see and buy".
 * Pure function — no DB access — so it's cheap to call once per product
 * across a whole catalog page without N+1 queries; callers fetch
 * actualStock/reservedQty in bulk first (see the Map helpers above).
 */
function resolveProductForCustomer(product, actualStock, reservedQty) {
  // ── Price (spec #7/#8) ────────────────────────────────────────────────
  const price = product.online_price_source === 'online'
    ? Number(product.online_price) || 0
    : Number(product.sales_rate) || 0

  // ── Sellable quantity (spec #10) ─────────────────────────────────────
  // Manual mode: the business's own online_qty number, exactly as set —
  // NULL (never configured) resolves to 0, never to "unlimited", so a
  // half-configured product fails safe rather than overselling.
  // Auto-sync mode: follows actual stock directly (spec's own example:
  // "Actual available stock = 127, Online available = 127" — no separate
  // reservation/commitment layer exists in this codebase to consult
  // beyond what SUM(qty_remaining) already reflects).
  const sellableQty = product.auto_sync_online_qty
    ? actualStock
    : Number(product.online_qty) || 0

  // ── Available online (spec #11) ──────────────────────────────────────
  const availableQty = Math.max(0, sellableQty - reservedQty)

  const minQty = Number(product.min_order_qty) || 1
  const maxQtyRaw = product.max_order_qty
  const maxQty = maxQtyRaw !== null && maxQtyRaw !== undefined ? Number(maxQtyRaw) : null
  const step = Number(product.qty_step) || 1

  const inStock = availableQty > 0 || product.allow_backorder
  const canOrder = (product.is_online && product.is_active !== false && inStock && availableQty >= minQty)
    || (product.allow_backorder && product.is_online && product.is_active !== false)

  // ── Stock visibility (spec #16) — display only; availableQty above is
  // still the real number every validation check uses regardless of what
  // the customer is shown. ─────────────────────────────────────────────
  let stockLabel = null
  if (availableQty <= 0) {
    stockLabel = product.allow_backorder ? 'Available for Backorder' : 'Out of Stock'
  } else {
    switch (product.stock_visibility) {
      case 'exact':     stockLabel = `${availableQty} available`; break
      case 'range':     stockLabel = `${Math.floor(availableQty / 10) * 10}+ available`; break
      case 'hide':      stockLabel = null; break
      case 'available':
      default:          stockLabel = 'Available'
    }
  }

  return {
    price,
    priceSource: product.online_price_source,
    actualStock,
    reservedQty,
    sellableQty,
    availableQty,
    minQty,
    maxQty,
    step,
    stockVisibility: product.stock_visibility,
    stockLabel,
    allowBackorder: !!product.allow_backorder,
    inStock,
    canOrder: !!canOrder,
  }
}

/**
 * Authoritative quantity validation (spec #12-14/#23) — used identically
 * when adding/updating a cart line AND, again, as the final word at
 * checkout. Returns { ok: true } or { ok: false, message }. Never trusts
 * a "checked at add-to-cart" flag as sufficient — every call re-validates
 * from a freshly-resolved product state.
 */
function validateQuantity(resolved, requestedQty) {
  const qty = Number(requestedQty)
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, message: 'Invalid quantity.' }
  if (qty < resolved.minQty) return { ok: false, message: `Minimum order quantity is ${resolved.minQty}.` }
  if (resolved.maxQty !== null && qty > resolved.maxQty) return { ok: false, message: `Maximum order quantity is ${resolved.maxQty}.` }
  if (resolved.step > 0) {
    // Floating-point-safe step check (12 - 24 - 36 style cartons, not
    // just integers) — round to 6dp before comparing remainders.
    const stepsFromMin = (qty - resolved.minQty) / resolved.step
    if (Math.abs(stepsFromMin - Math.round(stepsFromMin)) > 1e-6) {
      return { ok: false, message: `Quantity must be in steps of ${resolved.step}.` }
    }
  }
  if (qty > resolved.availableQty && !resolved.allowBackorder) {
    return { ok: false, message: resolved.availableQty > 0
      ? `Only ${resolved.availableQty} available. Please reduce your quantity.`
      : 'This product is currently out of stock.' }
  }
  return { ok: true }
}

/** Bulk-resolve a set of product rows in one pass — the shared plumbing
 *  behind the catalog list, product detail, and cart/checkout line
 *  validation, so none of them writes its own stock/reserved-qty queries. */
async function resolveMany(companyId, products) {
  const ids = products.map(p => p.id)
  const [stockMap, reservedMap] = await Promise.all([
    getActualStockMap(companyId, ids),
    getReservedQtyMap(companyId, ids),
  ])
  return products.map(p => ({
    product: p,
    resolved: resolveProductForCustomer(p, stockMap.get(p.id) || 0, reservedMap.get(p.id) || 0),
  }))
}

function toCatalogCard({ product, resolved }) {
  return {
    id: product.id,
    name: product.name,
    unit: product.unit,
    category: product.category,
    image_url: product.online_image_url || null,
    price: resolved.price,
    unit_label: product.unit ? `/ ${product.unit}` : '',
    stock_label: resolved.stockLabel,
    in_stock: resolved.inStock,
    can_order: resolved.canOrder,
    min_qty: resolved.minQty,
    max_qty: resolved.maxQty,
    qty_step: resolved.step,
    display_order: product.display_order || 0,
  }
}

function toProductDetail({ product, resolved }) {
  return {
    ...toCatalogCard({ product, resolved }),
    description: product.online_description || null,
    generic_name: product.generic_name || null,
  }
}

module.exports = {
  getActualStockMap, getReservedQtyMap, resolveProductForCustomer,
  validateQuantity, resolveMany, toCatalogCard, toProductDetail,
}
