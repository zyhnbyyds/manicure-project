/**
 * 地理距离（门店定位）。
 *
 * ## 为什么是 Haversine
 *
 * 门店之间通常几公里，这个量级下球面直线距离足够准（误差 < 0.5%），
 * 没必要上 Vincenty 那种椭球模型 —— 后者的复杂度换不来任何体验提升。
 *
 * ## 坐标系不转换
 *
 * 微信 `wx.getLocation({ type: 'gcj02' })` 给的是 **gcj02**，而后台门店经纬度是运营
 * 从高德 / 腾讯地图复制进来的，同样是 **gcj02** —— 两边可以直接相减。
 * **不要**在这里做 gcj02↔wgs84 转换：那会把本来正确的值弄偏。
 *
 * ## 缺坐标不是错误
 *
 * 门店可能没配经纬度（后台允许留空）。这类门店 `distance()` 返回 `null`，
 * 由 `sortByDistance()` 排到列表最后 —— **不要把它从列表里删掉**，
 * 顾客可能就在那家店附近，只是运营没填坐标。
 */

/** 地球平均半径（米） */
const EARTH_RADIUS_M = 6_371_000;

export type LatLng = { latitude: number | null; longitude: number | null };

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * 两点球面距离（米）；任一坐标缺失 / 非法返回 `null`。
 */
export function distanceMeters(
  from: LatLng | null | undefined,
  to: LatLng | null | undefined,
): number | null {
  if (!from || !to) return null;
  const { latitude: lat1, longitude: lon1 } = from;
  const { latitude: lat2, longitude: lon2 } = to;
  if (lat1 === null || lon1 === null || lat2 === null || lon2 === null)
    return null;
  if (![lat1, lon1, lat2, lon2].every((value) => Number.isFinite(value)))
    return null;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * 距离文案：不足 1km 显示到「十米」（`320m`），否则一位小数的公里（`1.4km`）。
 * `null` → 空串（调用方据此不显示这一行）。
 */
export function formatDistance(meters: number | null): string {
  if (meters === null) return '';
  // 先按十米取整再判单位：999m 应该显示 1.0km，而不是“1000m”
  const rounded = Math.round(meters / 10) * 10;
  if (rounded < 1000) return `${rounded}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}

/**
 * 按距离排序（**不改动入参**）：能算出距离的由近到远，
 * 缺坐标的保持原相对顺序排在最后（`Array.prototype.sort` 自 ES2019 起稳定）。
 *
 * `from` 为 `null`（没定位 / 用户拒绝授权）时原序返回，每项 `distance` 都是 `null` ——
 * 界面照常显示门店列表，只是不显示距离，而不是把列表清空。
 */
export function sortByDistance<T extends LatLng>(
  items: readonly T[],
  from: LatLng | null,
): (T & { distance: number | null })[] {
  return items
    .map((item) => ({ ...item, distance: distanceMeters(from, item) }))
    .sort((a, b) => {
      if (a.distance === null && b.distance === null) return 0;
      if (a.distance === null) return 1;
      if (b.distance === null) return -1;
      return a.distance - b.distance;
    });
}
