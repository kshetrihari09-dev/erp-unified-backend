-- ════════════════════════════════════════════════════════════════════════════
-- OPTIONAL, DESTRUCTIVE — NOT run by `knex migrate`.
-- Physically removes the data structures left behind by the removed online
-- shopping feature. Run ONLY after:
--   1. a full verified backup:  pg_dump -Fc <db> > before_drop.dump
--   2. explicit written authorization from the business owner
--   3. confirming no one needs the historical online-order data
-- Sales / invoices / stock / parties created from past online orders are
-- NOT affected (customer_orders only *references* sales, not vice-versa).
-- Run inside psql:  \i drop_online_shopping_tables.sql
-- Rollback: restore the backup (this script is not reversible by itself).
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

-- 1. Archive first (kept in the same DB; drop the archive_* tables later).
CREATE TABLE IF NOT EXISTS archive_customer_orders       AS TABLE customer_orders;
CREATE TABLE IF NOT EXISTS archive_customer_order_items  AS TABLE customer_order_items;
CREATE TABLE IF NOT EXISTS archive_customer_accounts     AS TABLE customer_accounts;

-- 2. Drop shopping-only tables (children first).
DROP TABLE IF EXISTS customer_cart_items;
DROP TABLE IF EXISTS customer_order_items;
DROP TABLE IF EXISTS customer_orders;
DROP TABLE IF EXISTS customer_accounts;

-- 3. Drop shopping-only columns.
ALTER TABLE products
  DROP COLUMN IF EXISTS is_online,
  DROP COLUMN IF EXISTS online_price_source,
  DROP COLUMN IF EXISTS online_price,
  DROP COLUMN IF EXISTS online_qty,
  DROP COLUMN IF EXISTS auto_sync_online_qty,
  DROP COLUMN IF EXISTS min_order_qty,
  DROP COLUMN IF EXISTS max_order_qty,
  DROP COLUMN IF EXISTS qty_step,
  DROP COLUMN IF EXISTS stock_visibility,
  DROP COLUMN IF EXISTS allow_backorder,
  DROP COLUMN IF EXISTS online_description,
  DROP COLUMN IF EXISTS display_order;
-- NOTE: products.online_image_url is KEPT — it now stores the product photo
-- used by the back-office product form.

ALTER TABLE companies DROP COLUMN IF EXISTS storefront_code;

COMMIT;
-- Afterwards `knex migrate:rollback` of 034–038 will no longer be possible;
-- do not roll those back once this script has been applied.
