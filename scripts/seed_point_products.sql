-- Seed point products for the points shop (devops#884, #852 UI 联调数据).
-- Run manually against a MySQL database that has the point_products table
-- (AutoMigratePoints creates it on `stride api` startup):
--   mysql -h <host> -u <user> -p <db> < scripts/seed_point_products.sql
-- Idempotent-ish: every row is stamped with this seed's marker name; re-running
-- inserts duplicates on purpose is NOT desired, so each INSERT is guarded by a
-- NOT EXISTS check on the product name.
-- per_user_limit: 0 = unlimited. status: active|inactive (下架=inactive，永不硬删).

INSERT INTO point_products (name, description, image_url, points_price, stock, per_user_limit, status, sort_order, created_at, updated_at)
SELECT 'STRIDE 运动毛巾', '速干面料 40×80cm，STRIDE logo 印花', NULL, 50, 200, 0, 'active', 10, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)
WHERE NOT EXISTS (SELECT 1 FROM point_products WHERE name = 'STRIDE 运动毛巾');

INSERT INTO point_products (name, description, image_url, points_price, stock, per_user_limit, status, sort_order, created_at, updated_at)
SELECT 'STRIDE 贴纸包', '反光贴纸 6 张装，夜跑装备首选', NULL, 20, 500, 5, 'active', 20, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)
WHERE NOT EXISTS (SELECT 1 FROM point_products WHERE name = 'STRIDE 贴纸包');

INSERT INTO point_products (name, description, image_url, points_price, stock, per_user_limit, status, sort_order, created_at, updated_at)
SELECT 'STRIDE 束口袋', '轻量收纳束口袋，可装手机与钥匙', NULL, 80, 100, 2, 'active', 30, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)
WHERE NOT EXISTS (SELECT 1 FROM point_products WHERE name = 'STRIDE 束口袋');

INSERT INTO point_products (name, description, image_url, points_price, stock, per_user_limit, status, sort_order, created_at, updated_at)
SELECT 'STRIDE 空顶帽', '透气网眼空顶帽，可调节头围', NULL, 200, 50, 1, 'active', 40, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)
WHERE NOT EXISTS (SELECT 1 FROM point_products WHERE name = 'STRIDE 空顶帽');

INSERT INTO point_products (name, description, image_url, points_price, stock, per_user_limit, status, sort_order, created_at, updated_at)
SELECT 'STRIDE 压缩袖套', 'UV 防护压缩袖套（一对装）', NULL, 300, 30, 1, 'active', 50, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6)
WHERE NOT EXISTS (SELECT 1 FROM point_products WHERE name = 'STRIDE 压缩袖套');
