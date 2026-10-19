export const TYPE_LABELS = { car: "汽車", motorcycle: "機車" };
const TYPE_ORDER = ["car", "motorcycle"];

export const LEGAL_VALUES = ["ok", "risky", "confirm"];
export const LEGAL_LABELS = { ok: "未查到限制", risky: "可能違規", confirm: "需確認" };

export const TIER_ORDER = ["starter", "advanced", "extreme"];
export const TIER_FALLBACK_NAMES = { starter: "入門", advanced: "進階", extreme: "極致" };

export const PRICE_BUCKETS = [
  { id: "all", name: "不限價格" },
  { id: "lt5k", name: "5 千以下", min: 0, max: 5000 },
  { id: "5k-20k", name: "5 千 – 2 萬", min: 5000, max: 20000 },
  { id: "20k-50k", name: "2 萬 – 5 萬", min: 20000, max: 50000 },
  { id: "gt50k", name: "5 萬以上", min: 50000, max: Infinity },
];

const isNum = v => typeof v === "number" && Number.isFinite(v);

/* ---------- 正規化 ---------- */

/** priceTWD：數字或 {min,max}；min 或 max 為 null 視為「詢價」（回傳 null）。 */
export function priceRange(p) {
  if (isNum(p)) return { min: p, max: p };
  if (p && typeof p === "object" && isNum(p.min) && isNum(p.max)) {
    return { min: Math.min(p.min, p.max), max: Math.max(p.min, p.max) };
  }
  return null;
}

/** 只接受物件 {legal, reason, source}；其他寫法一律視為沒有覆蓋。 */
function normalizeLegalOverride(o) {
  const lo = o.legalOverride;
  if (lo && typeof lo === "object" && !Array.isArray(lo) && LEGAL_VALUES.includes(lo.legal)) {
    return { legal: lo.legal, reason: lo.reason || "", source: lo.source || "" };
  }
  return null;
}

export const PRICE_BASIS_LABELS = {
  "TWD-listed": "台灣賣場新台幣標價",
  "Shopee-search-card": "蝦皮標價，以賣場頁面為準",
  "Shopee-page": "蝦皮商品頁標價，以賣場頁面為準",
};

const SHOP_LABELS = [
  [/(^|\.)shopee\.tw$/, "蝦皮購物"],
  [/(^|\.)pchome\.com\.tw$/, "PChome 24h"],
];

function hostOfUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/** 賣場名稱：依購買連結（沒有則依 source）的網域，已知賣場用中文名，其餘顯示網域。 */
export function shopLabel(option) {
  const host = hostOfUrl(option?.purchase?.url) || hostOfUrl(option?.source);
  if (!host) return "";
  const hit = SHOP_LABELS.find(([re]) => re.test(host));
  return hit ? hit[1] : host;
}
/** 沒有 priceUnit、但 priceNote 表明計價單位（單顆／整組）未確認的選項。 */
const UNIT_UNCERTAIN_RE = /單顆|單輪|單支|計價單位|整組或|一組或/;
export function isUnitUncertain(option) {
  return !option?.priceUnit && UNIT_UNCERTAIN_RE.test(option?.priceNote || "");
}

export function priceBasisLabel(option) {
  if (!option?.priceBasis) return "";
  return PRICE_BASIS_LABELS[option.priceBasis] || option.priceBasis;
}

function normalizeRelations(o) {
  const out = [];
  const add = (item, fallback) => {
    if (typeof item === "string") out.push({ id: item, relation: fallback, note: "" });
    else if (item && typeof item === "object" && item.id) {
      out.push({ id: item.id, relation: item.relation === "requires" ? "requires" : item.relation === "conflict" ? "conflict" : fallback, note: item.note || "" });
    }
  };
  (Array.isArray(o.conflicts) ? o.conflicts : []).forEach(i => add(i, "conflict"));
  (Array.isArray(o.requires) ? o.requires : []).forEach(i => add(i, "requires"));
  return out;
}

function normalizePurchase(o) {
  const p = o.purchase;
  if (p && typeof p === "object") {
    return { url: p.url || null, isAffiliate: p.isAffiliate === true, searchKeyword: p.searchKeyword || "", shop: p.shop || "" };
  }
  const l = Array.isArray(o.links) ? o.links.find(x => x && x.url) : null;
  return l ? { url: l.url, isAffiliate: l.isAffiliate === true, searchKeyword: "", shop: l.shop || "" } : null;
}

function normalizeFits(o) {
  const f = o.fits || o.compat || {};
  const sources = [f.source, ...(Array.isArray(f.sourceMore) ? f.sourceMore : [])].filter(u => typeof u === "string" && u);
  if (f.universal === true) {
    const vehicleTypes = Array.isArray(f.vehicleTypes) && f.vehicleTypes.length ? f.vehicleTypes : null;
    return { universal: true, vehicleTypes, vehicleIds: [], note: f.note || f.yearNote || "", sources };
  }
  const ids = Array.isArray(f.vehicleIds) ? f.vehicleIds : Array.isArray(f.models) ? f.models.map(m => m.modelId) : [];
  return { universal: false, vehicleTypes: null, vehicleIds: ids, note: f.yearNote || f.note || "", sources };
}

export function normalizeOption(o) {
  return {
    id: o.optionId ?? o.id,
    brand: o.brand || "",
    name: o.name || "",
    price: priceRange(o.priceTWD),
    priceIsReference: o.priceIsReference !== false,
    priceNote: o.priceNote || "",
    priceBasis: typeof o.priceBasis === "string" ? o.priceBasis : "",
    priceUnit: typeof o.priceUnit === "string" ? o.priceUnit : "",
    fits: normalizeFits(o),
    relations: normalizeRelations(o),
    installDifficulty: isNum(o.installDifficulty) ? o.installDifficulty : null,
    source: o.source || "",
    purchase: normalizePurchase(o),
    legalOverride: normalizeLegalOverride(o),
    vehicleType: o.vehicleType || null,
  };
}

export function expandGenerations(vehicle) {
  return (vehicle.generations || []).map((g, index) => {
    const from = Number(g.yearFrom);
    const to = isNum(Number(g.yearTo)) && g.yearTo !== null ? Number(g.yearTo) : from;
    const years = [];
    for (let y = Math.max(from, to); y >= Math.min(from, to); y--) years.push(y);
    return { index, name: g.name || "", yearFrom: from, yearTo: to, ongoing: g.ongoing === true, uncertain: g.uncertain === true, note: g.note || "", years };
  });
}

/* ---------- 資料組合 ---------- */

export const makeKeyOf = v => v.makeEn || v.make || "";

/**
 * 組合各資料檔：
 * - vehicles.json：扁平車款清單，依 type → make 分組
 * - slots.json：部位基準（名稱、分類、appliesTo）
 * - parts.json：選項掛在 slotId 底下
 * - themes.json：改裝方向
 * - legal-notes.json：部位層級合法性預設值
 */
export function buildCatalog({ vehicles, slotsData, parts, themes, legalNotes }) {
  const vehicleList = (Array.isArray(vehicles?.vehicles) ? vehicles.vehicles : []).map(v => ({ ...v, gens: expandGenerations(v) }));
  const vehicleById = new Map(vehicleList.map(v => [v.id, v]));
  const typeIds = [...new Set(vehicleList.map(v => v.type))].sort((a, b) => (TYPE_ORDER.indexOf(a) + 1 || 99) - (TYPE_ORDER.indexOf(b) + 1 || 99));
  const types = typeIds.map(type => {
    const makes = new Map();
    for (const v of vehicleList.filter(x => x.type === type)) {
      const key = makeKeyOf(v);
      if (!makes.has(key)) makes.set(key, { key, name: v.make || key, nameZh: v.makeZh || "", nameEn: v.makeEn || "", vehicles: [] });
      makes.get(key).vehicles.push(v);
    }
    return { type, makes: [...makes.values()] };
  });

  const baseIds = new Set((slotsData?.slots || []).map(s => s.slotId));
  const optionsBySlot = new Map();
  const orphanPartSlots = [];
  for (const ps of parts?.slots || []) {
    const sid = ps.slotId ?? ps.id;
    if (!baseIds.has(sid)) { orphanPartSlots.push(sid); continue; }
    optionsBySlot.set(sid, [...(optionsBySlot.get(sid) || []), ...(ps.options || []).map(normalizeOption)]);
  }
  const slots = (slotsData?.slots || []).map(s => ({
    id: s.slotId,
    name: s.name,
    category: s.category || "其他",
    appliesTo: Array.isArray(s.appliesTo) ? s.appliesTo : [],
    options: optionsBySlot.get(s.slotId) || [],
  }));
  const slotById = new Map(slots.map(s => [s.id, s]));
  const optionById = new Map();
  for (const slot of slots) for (const option of slot.options) optionById.set(option.id, { slot, option });

  const notesByKey = new Map();
  for (const n of legalNotes?.notes || []) notesByKey.set(`${n.slotId}|${n.vehicleType}`, n);

  const vehiclesWithParts = new Set();
  for (const slot of slots) for (const o of slot.options) o.fits.vehicleIds.forEach(id => vehiclesWithParts.add(id));

  return {
    vehicles: vehicleList,
    vehicleById,
    types,
    slots,
    slotById,
    optionById,
    categories: Array.isArray(slotsData?.categories) ? slotsData.categories : [],
    themes: Array.isArray(themes?.themes) ? themes.themes : [],
    legal: { disclaimer: legalNotes?.disclaimer || "", enum: legalNotes?.legalEnum || {}, notesByKey },
    vehiclesWithParts,
    orphanPartSlots,
    hasAffiliate: slots.some(s => s.options.some(o => o.purchase?.url && o.purchase.isAffiliate)),
    note: parts?._note || "",
  };
}

export function typeLabel(type) {
  return TYPE_LABELS[type] || type || "";
}

/** sel = { type, makeKey, vehicleId, year, gen }，回傳驗證過的物件。 */
export function resolveSelection(catalog, sel = {}) {
  const t = catalog.types.find(x => x.type === sel.type) || null;
  const make = t?.makes.find(m => m.key === sel.makeKey) || null;
  const vehicle = make?.vehicles.find(v => v.id === sel.vehicleId) || null;
  const gen = vehicle?.gens.find(g => g.index === Number(sel.gen)) || null;
  const year = gen && gen.years.includes(Number(sel.year)) ? Number(sel.year) : null;
  return { type: t, make, vehicle, gen: year ? gen : null, year };
}

export function hasVehicleParts(catalog, vehicleId) {
  return catalog.vehiclesWithParts.has(vehicleId);
}

/* ---------- 合法性 ---------- */

/** 先以 (slotId, vehicleType) 精確比對，找不到再找 vehicleType = "both"。 */
export function slotLegal(catalog, slotId, vehicleType) {
  const m = catalog.legal.notesByKey;
  return m.get(`${slotId}|${vehicleType}`) || m.get(`${slotId}|both`) || null;
}

/** 選項合法性：預設繼承部位，有 legalOverride（或舊欄位 legal）則覆蓋。 */
export function optionLegal(catalog, slot, option, vehicleType) {
  const base = slotLegal(catalog, slot.id, vehicleType);
  const inherited = base && LEGAL_VALUES.includes(base.legal)
    ? { legal: base.legal, note: base.legalNote || "", basis: base.basis || "", source: base.source || "", sourceMore: base.sourceMore || [] }
    : null;
  const ov = option?.legalOverride;
  if (!ov) return inherited ? { ...inherited, override: null } : null;
  return {
    legal: ov.legal,
    note: inherited?.note || "",
    basis: inherited?.basis || "",
    source: inherited?.source || "",
    sourceMore: inherited?.sourceMore || [],
    inheritedLegal: inherited?.legal || null,
    override: { reason: ov.reason, source: ov.source },
  };
}

/* ---------- 價格 ---------- */

const nf = new Intl.NumberFormat("zh-TW");
export function formatPrice(range) {
  if (!range) return "詢價";
  if (range.min === range.max) return `NT$ ${nf.format(range.min)}`;
  return `NT$ ${nf.format(range.min)} – ${nf.format(range.max)}`;
}

/**
 * 詢價（price 為 null）的選項不計入總額，以 inquiry 回報筆數。
 * 每個選項只有一個價格，就是資料標示的那個購買單位（例如輪胎「4 條一組」是整組價），
 * 加總時照原價計入、不做單位換算；units 列出計入總額的非預設單位，供畫面註明。
 */
export function sumPrices(options) {
  let min = 0, max = 0, inquiry = 0, unitUncertain = 0;
  const units = new Map();
  for (const o of options) {
    if (!o.price) { inquiry++; continue; }
    min += o.price.min;
    max += o.price.max;
    if (o.priceUnit) units.set(o.priceUnit, (units.get(o.priceUnit) || 0) + 1);
    else if (isUnitUncertain(o)) unitUncertain++;
  }
  return {
    min, max, count: options.length, priced: options.length - inquiry, inquiry,
    units: [...units].map(([unit, count]) => ({ unit, count })),
    unitUncertain,
  };
}

/* ---------- 適用判斷 ---------- */

export function slotAppliesTo(slot, type) {
  return !type || (slot?.appliesTo || []).includes(type);
}

/**
 * 只看 fits.vehicleIds 是否包含所選車款；universal 通用，但有 fits.vehicleTypes 時只限那些車種。
 * 年式只以 yearNote 提示。
 */
export function isCompatible(option, vehicle) {
  if (!option?.fits) return false;
  if (option.vehicleType && vehicle?.type && option.vehicleType !== vehicle.type) return false;
  if (option.fits.universal) return !option.fits.vehicleTypes || option.fits.vehicleTypes.includes(vehicle?.type);
  return !!vehicle?.vehicleId && option.fits.vehicleIds.includes(vehicle.vehicleId);
}

/** 明列車款的選項排在通用品前面（各自維持資料順序），避免通用品洗版。 */
export function compatibleOptions(slot, vehicle) {
  if (!slotAppliesTo(slot, vehicle?.type)) return [];
  const fit = (slot?.options || []).filter(o => isCompatible(o, vehicle));
  return [...fit.filter(o => !o.fits.universal), ...fit.filter(o => o.fits.universal)];
}

export function slotsForType(catalog, type) {
  return catalog.slots.filter(s => slotAppliesTo(s, type));
}

export function fitsSummary(catalog, option) {
  if (option.fits.universal) {
    const t = option.fits.vehicleTypes;
    return t ? `${t.map(typeLabel).join("、")}通用品` : "通用品";
  }
  return option.fits.vehicleIds.map(id => catalog.vehicleById.get(id)?.model || id).join("、");
}

export function refLabel(catalog, id) {
  const slot = catalog.slotById.get(id);
  if (slot) return slot.name;
  const hit = catalog.optionById.get(id);
  if (hit) return `${hit.option.brand} ${hit.option.name}`;
  return id;
}

export function refSlotId(catalog, id) {
  if (catalog.slotById.has(id)) return id;
  return catalog.optionById.get(id)?.slot.id || null;
}

/* ---------- 改裝方向 ---------- */

export function themesForType(catalog, type) {
  return catalog.themes
    .map(theme => ({ theme, variant: (theme.variants || []).find(v => v.vehicleType === type) || null }))
    .filter(x => x.variant && (!Array.isArray(x.theme.appliesTo) || x.theme.appliesTo.includes(type)));
}

export function findVariant(catalog, themeId, type) {
  return themesForType(catalog, type).find(x => x.theme.id === themeId) || null;
}

export function tierIds(variant) {
  const keys = Object.keys(variant?.tiers || {});
  return [...TIER_ORDER.filter(k => keys.includes(k)), ...keys.filter(k => !TIER_ORDER.includes(k))];
}

export function tierName(variant, tierId) {
  return variant?.tiers?.[tierId]?.name || TIER_FALLBACK_NAMES[tierId] || tierId;
}

/** 依 includes 往下合併增量項目，依 priority 由小到大排序（同資料 README 的 resolve()）。 */
export function resolveTierItems(variant, tierId) {
  const chain = [];
  const seen = new Set();
  let cur = tierId;
  while (cur && variant?.tiers?.[cur] && !seen.has(cur)) {
    seen.add(cur);
    chain.unshift(cur);
    cur = variant.tiers[cur].includes;
  }
  const bySlot = new Map();
  for (const it of chain.flatMap(t => variant.tiers[t].items || [])) if (!bySlot.has(it.slotId)) bySlot.set(it.slotId, it);
  return [...bySlot.values()].sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity));
}

/** 套組的每個部位：預設款式為該部位第一個適用選項；使用者已選的同部位款式優先。 */
export function tierPlan(catalog, variant, tierId, vehicle, picks = {}) {
  return resolveTierItems(variant, tierId)
    .map(it => {
      const slot = catalog.slotById.get(it.slotId);
      if (!slot || !slotAppliesTo(slot, vehicle?.type)) return null;
      const options = compatibleOptions(slot, vehicle);
      const picked = options.find(o => o.id === picks[slot.id]) || null;
      return {
        slot, why: it.defaultReason || "", priority: it.priority, options,
        shown: picked || options[0] || null,
        custom: !!picked && picked !== options[0],
      };
    })
    .filter(Boolean);
}

/* ---------- 清單 ---------- */

export function pickedEntries(catalog, picks) {
  return Object.entries(picks || {})
    .map(([slotId, optionId]) => {
      const hit = catalog.optionById.get(optionId);
      return hit && hit.slot.id === slotId ? { slot: hit.slot, option: hit.option } : null;
    })
    .filter(Boolean);
}

export function sumPicks(catalog, picks) {
  return sumPrices(pickedEntries(catalog, picks).map(e => e.option));
}

export function checkIssues(catalog, picks) {
  const entries = pickedEntries(catalog, picks);
  const issues = [];
  const pairSeen = new Set();
  for (const a of entries) {
    for (const rel of a.option.relations) {
      if (rel.relation === "conflict") {
        for (const b of entries) {
          if (b === a || (b.option.id !== rel.id && b.slot.id !== rel.id)) continue;
          const key = [a.option.id, b.option.id].sort().join("|");
          if (pairSeen.has(key)) continue;
          pairSeen.add(key);
          issues.push({ type: "conflict", a, b, note: rel.note });
        }
      } else if (!entries.some(e => e.option.id === rel.id || e.slot.id === rel.id)) {
        issues.push({ type: "requires", a, ref: rel.id, note: rel.note, label: refLabel(catalog, rel.id), slotId: refSlotId(catalog, rel.id) });
      }
    }
  }
  return issues;
}

export function pruneIncompatible(catalog, picks, vehicle) {
  const kept = {};
  const removed = [];
  for (const e of pickedEntries(catalog, picks)) {
    if (slotAppliesTo(e.slot, vehicle.type) && isCompatible(e.option, vehicle)) kept[e.slot.id] = e.option.id;
    else removed.push(e);
  }
  return { picks: kept, removed };
}

/* ---------- 篩選 ---------- */

function bucketMatch(range, bucketId) {
  const b = PRICE_BUCKETS.find(x => x.id === bucketId);
  if (!b || b.id === "all") return true;
  if (!range) return false;
  return range.max >= b.min && range.min < b.max;
}

export function sortedCategories(catalog, categories) {
  const order = catalog.categories || [];
  return [...order.filter(c => categories.includes(c)), ...categories.filter(c => !order.includes(c))];
}

/**
 * 依車款篩選部位與選項。沒有選項的部位仍會列出（options 為空），
 * 但使用品牌或價格篩選時只留下有符合選項的部位。
 */
export function filterCatalog(catalog, vehicle, f = {}) {
  const q = (f.q || "").trim().toLowerCase();
  const optionFilter = (f.brand && f.brand !== "all") || (f.price && f.price !== "all");
  const groups = new Map();
  for (const slot of slotsForType(catalog, vehicle?.type)) {
    if (f.category && f.category !== "all" && slot.category !== f.category) continue;
    const slotHit = !q || `${slot.name} ${slot.category} ${slot.id}`.toLowerCase().includes(q);
    const all = compatibleOptions(slot, vehicle);
    const options = all.filter(o => {
      if (f.legalOnly && optionLegal(catalog, slot, o, vehicle?.type)?.legal !== "ok") return false;
      if (f.brand && f.brand !== "all" && o.brand !== f.brand) return false;
      if (!bucketMatch(o.price, f.price)) return false;
      if (!slotHit && !`${o.brand} ${o.name}`.toLowerCase().includes(q)) return false;
      return true;
    });
    let keep = options.length > 0;
    if (!keep && !optionFilter && slotHit && all.length === 0) {
      keep = !f.legalOnly || slotLegal(catalog, slot.id, vehicle?.type)?.legal === "ok";
    }
    if (!keep) continue;
    if (!groups.has(slot.category)) groups.set(slot.category, []);
    groups.get(slot.category).push({ slot, options, total: all.length });
  }
  return sortedCategories(catalog, [...groups.keys()]).map(category => ({ category, slots: groups.get(category) }));
}

export function availableFacets(catalog, vehicle) {
  const brands = new Set();
  const counts = new Map();
  for (const slot of slotsForType(catalog, vehicle?.type)) {
    counts.set(slot.category, (counts.get(slot.category) || 0) + 1);
    compatibleOptions(slot, vehicle).forEach(o => brands.add(o.brand));
  }
  return {
    brands: [...brands].sort((a, b) => a.localeCompare(b)),
    categories: sortedCategories(catalog, [...counts.keys()]).map(c => ({ name: c, count: counts.get(c) })),
  };
}

/* ---------- 分享連結 ---------- */

export function encodeShare(state) {
  const out = [];
  const add = (k, v) => out.push(`${k}=${encodeURIComponent(v).replace(/%2C/g, ",")}`);
  const s = state.sel || {};
  if (s.vehicleId) add("v", [s.vehicleId, s.year, s.gen].filter(x => x !== undefined && x !== null && x !== "").join("~"));
  else if (s.type) add("v", s.type);
  const picks = Object.entries(state.picks || {}).map(([k, v]) => `${k}~${v}`).join(",");
  if (picks) add("p", picks);
  if (state.themeId) add("d", state.themeId);
  if (state.tier) add("t", state.tier);
  return out.join("&");
}

export function decodeShare(hash, catalog) {
  const raw = String(hash || "").replace(/^#/, "");
  if (!raw) return null;
  const p = new URLSearchParams(raw);
  if (!p.has("v")) return null;
  const [first, year, gen] = (p.get("v") || "").split("~");
  const v = catalog.vehicleById.get(first);
  let sel;
  if (v) {
    const r = resolveSelection(catalog, { type: v.type, makeKey: makeKeyOf(v), vehicleId: v.id, year, gen });
    sel = { type: v.type, makeKey: makeKeyOf(v), vehicleId: v.id, year: r.year, gen: r.gen ? r.gen.index : null };
  } else if (catalog.types.some(t => t.type === first)) {
    sel = { type: first, makeKey: null, vehicleId: null, year: null, gen: null };
  } else return null;
  const picks = {};
  for (const pair of (p.get("p") || "").split(",")) {
    const [slotId, optionId] = pair.split("~");
    const hit = catalog.optionById.get(optionId);
    if (hit && hit.slot.id === slotId) picks[slotId] = optionId;
  }
  const found = findVariant(catalog, p.get("d"), sel.type);
  return {
    sel,
    picks,
    themeId: found ? found.theme.id : null,
    tier: found && tierIds(found.variant).includes(p.get("t")) ? p.get("t") : "starter",
  };
}
