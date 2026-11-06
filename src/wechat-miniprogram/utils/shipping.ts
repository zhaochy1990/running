// 运费展示换算（devops#905）—— 镜像 storage/points.go shippingFeeFor 的客户端口径：
// jzsh_fee 且收货省份 ∉ {江苏,浙江,上海} 才收 shipping_fee（分），其余一律免运
// （nationwide_free 及任何未知策略值都免运，与服务端闭枚举回退一致）。
// 纯函数、不触 wx —— utils/shipping.check.mts 进 npm test 链。

/** 江浙沪包邮块：地址簿存原生 region-picker 全称（含行政后缀），裸名也认
 * （服务端 jzshProvinces 同款集合，管理端种的数据口径一致）。 */
const JZSH_PROVINCES = new Set(['江苏省', '浙江省', '上海市', '江苏', '浙江', '上海']);

/** 商品运费策略（服务端闭枚举，point_products.shipping_policy）。 */
export type ShippingPolicy = 'nationwide_free' | 'jzsh_fee';

/**
 * 按收货省份算一单应收运费（分）。policy 缺省（旧后端响应无此字段）按
 * nationwide_free 处理 —— 展示层永不比服务端多收。
 */
export function shippingFeeFen(policy: string | undefined, feeFen: number, province: string): number {
  if (policy !== 'jzsh_fee' || JZSH_PROVINCES.has(province)) return 0;
  return feeFen;
}

/** 分 → 元字符串，去尾零：0→'0'，800→'8'，850→'8.5'，808→'8.08'。 */
export function formatFen(fen: number): string {
  return (fen / 100).toFixed(2).replace(/\.?0+$/, '') || '0';
}
