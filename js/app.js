import {
  LEGAL_LABELS, PRICE_BUCKETS, buildCatalog, typeLabel, resolveSelection, formatPrice,
  compatibleOptions, fitsSummary, refLabel, pickedEntries, sumPrices, sumPicks, checkIssues,
  pruneIncompatible, filterCatalog, availableFacets, encodeShare, decodeShare, sortedCategories,
  slotLegal, optionLegal, themesForType, findVariant, tierIds, tierName, resolveTierItems, tierPlan,
  hasVehicleParts, priceBasisLabel, isUnitUncertain, shopLabel, brandSummary, needsYearCheck, searchVehicles, makeKeyOf,
} from "./logic.js";

const STORAGE_KEY = "kaizou-planner:v3";
const STEPS = [
  { id: "type", name: "車種" },
  { id: "make", name: "車商" },
  { id: "model", name: "車款" },
  { id: "year", name: "年式" },
  { id: "direction", name: "改裝方向" },
  { id: "parts", name: "改裝品" },
];
const DEFAULT_FILTERS = { q: "", category: "all", price: "all", brand: "all", legalOnly: false };
const EMPTY_SEL = { type: null, makeKey: null, vehicleId: null, year: null, gen: null };
const PENDING = "資料整理中";
const FOLD_AT = 4;
const expandedSlots = new Set();

let catalog = null;
let partsReady = false;
let partsError = null;
const state = {
  step: "type",
  sel: { ...EMPTY_SEL },
  themeId: null,
  tier: "starter",
  tab: "package",
  picks: {},
  filters: { ...DEFAULT_FILTERS },
};

const $ = (sel, root = document) => root.querySelector(sel);
const main = $("#main");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ICON = {
  warn: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18v.01"/></svg>',
  info: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></svg>',
  check: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
  ext: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  search: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  car: '<svg viewBox="0 0 64 40" aria-hidden="true"><path d="M6 28v-6l6-2 8-9h22l10 9 6 2v6"/><circle cx="17" cy="29" r="5"/><circle cx="47" cy="29" r="5"/><path d="M22 29h20M20 20h36"/></svg>',
  motorcycle: '<svg viewBox="0 0 64 40" aria-hidden="true"><circle cx="13" cy="28" r="7"/><circle cx="51" cy="28" r="7"/><path d="M13 28l10-12h12l6 12h10M35 16l-4-6h-6M41 28l4-10h6"/></svg>',
  chev: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
};

/* ---------- persistence ---------- */

function save() {
  try {
    const { step, sel, themeId, tier, tab, picks } = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ step, sel, themeId, tier, tab, picks }));
  } catch { /* storage may be unavailable (private mode) */ }
}

function selFromResolved(r) {
  return {
    type: r.type?.type || null,
    makeKey: r.make?.key || null,
    vehicleId: r.vehicle?.id || null,
    year: r.year,
    gen: r.gen ? r.gen.index : null,
  };
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!raw) return;
    state.sel = selFromResolved(resolveSelection(catalog, raw.sel || {}));
    const found = findVariant(catalog, raw.themeId, state.sel.type);
    state.themeId = found ? found.theme.id : null;
    state.tier = found && tierIds(found.variant).includes(raw.tier) ? raw.tier : "starter";
    state.tab = raw.tab === "browse" ? "browse" : "package";
    const valid = {};
    for (const e of pickedEntries(catalog, raw.picks || {})) valid[e.slot.id] = e.option.id;
    state.picks = state.sel.vehicleId ? pruneIncompatible(catalog, valid, vehicle()).picks : valid;
    state.step = clampStep(STEPS.some(s => s.id === raw.step) ? raw.step : "type");
  } catch { /* ignore corrupt storage */ }
}

/* ---------- helpers ---------- */

const vehicle = () => ({ type: state.sel.type, vehicleId: state.sel.vehicleId, year: state.sel.year });
const selection = () => resolveSelection(catalog, state.sel);
const current = () => findVariant(catalog, state.themeId, state.sel.type);
const stepIndex = id => STEPS.findIndex(s => s.id === id);
const vehicleHasParts = () => !!state.sel.vehicleId && hasVehicleParts(catalog, state.sel.vehicleId);

function maxStepIndex() {
  const s = state.sel;
  if (!s.type) return 0;
  if (!s.makeKey) return 1;
  if (!s.vehicleId) return 2;
  if (!s.year) return 3;
  return 5;
}

const clampStep = id => (stepIndex(id) > maxStepIndex() ? STEPS[maxStepIndex()].id : id);

function vehicleName() {
  const { make, vehicle: v, year, gen } = selection();
  return [make?.nameZh || make?.name, v?.model, year ? `${year} 年式${gen?.name ? `（${gen.name}）` : ""}` : ""].filter(Boolean).join(" ");
}

function safeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url, location.href);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch { return null; }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/* ---------- legal ---------- */

function legalBadge(legal) {
  if (!LEGAL_LABELS[legal]) return `<span class="badge badge--none">尚無合法性資料</span>`;
  const meaning = catalog.legal.enum[legal] || "";
  return `<span class="badge badge--${esc(legal)}" title="${esc(meaning)}">${legal === "ok" ? ICON.check : ICON.warn}${esc(LEGAL_LABELS[legal])}</span>`;
}

/** 選項的標記；被 legalOverride 改過的加註「依商品標示」，避免讀成已確認合法。 */
function optionBadge(info) {
  if (!info?.override || info.legal !== "ok") return legalBadge(info?.legal);
  return `<span class="badge-group">${legalBadge(info.legal)}<span class="badge-sub">依商品標示</span></span>`;
}

function sourceLinks(urls) {
  return urls.filter(u => safeUrl(u)).map((u, i) =>
    `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${i === 0 ? "主要來源" : `其他來源 ${i}`}</a>`).join("");
}

function basisDetails(info) {
  const urls = [info.source, ...(info.sourceMore || [])].filter(Boolean);
  if (!info.basis && !urls.length) return "";
  return `<dl class="basis">
    ${info.basis ? `<dt>依據</dt><dd>${esc(info.basis)}</dd>` : ""}
    ${urls.length ? `<dt>來源</dt><dd class="basis__links">${sourceLinks(urls)}</dd>` : ""}
  </dl>`;
}

/** 部位層級的合法性提醒：短提醒可展開看依據與來源。 */
function slotLegalBlock(slot, { open = false } = {}) {
  const n = slotLegal(catalog, slot.id, state.sel.type);
  if (!n) return "";
  const details = basisDetails({ basis: n.basis, source: n.source, sourceMore: n.sourceMore || [] });
  if (!n.legalNote && !details) return "";
  const cls = `legal legal--${esc(n.legal)}`;
  if (!details) return `<p class="${cls}">${ICON.warn}<span>${esc(n.legalNote)}</span></p>`;
  return `<details class="${cls}"${open ? " open" : ""}>
    <summary>${n.legal === "ok" ? ICON.info : ICON.warn}<span class="legal__text">${esc(n.legalNote || "查看依據與來源")}</span></summary>
    <div class="legal__more">${details}</div>
  </details>`;
}

/** 選項若覆蓋了部位的合法性，顯示覆蓋理由與來源。 */
function overrideBlock(slot, option) {
  const info = optionLegal(catalog, slot, option, state.sel.type);
  if (!info?.override) return "";
  const { reason, source } = info.override;
  const was = info.inheritedLegal ? `部位預設為「${LEGAL_LABELS[info.inheritedLegal]}」；` : "";
  const url = safeUrl(source);
  const ok = info.legal === "ok";
  return `<div class="legal legal--${esc(info.legal)} legal--override">
    <p class="legal__head">${ok ? ICON.info : ICON.warn}<span>${esc(was)}此款${ok ? "依商品標示列為" : "另標為"}「${esc(LEGAL_LABELS[info.legal])}」</span></p>
    ${reason ? `<p class="legal__reason"><span class="muted">${ok ? "標示內容" : "理由"}：</span>${esc(reason)}</p>` : ""}
    ${ok ? `<p class="legal__caveat">這是依賣家或廠商頁面的說法，本站未核對認證編號，不代表已確認合法；仍須自行確認車輛型式對應，並依規定辦理登錄或變更登記。</p>` : ""}
    ${url ? `<p class="legal__src"><span class="muted">標示來源：</span><a href="${esc(url)}" target="_blank" rel="noopener">${esc(hostOf(url) || "查看")}</a></p>` : ""}
  </div>`;
}

function legalHelp() {
  const e = catalog.legal.enum;
  return `<details class="legal-help">
    <summary>${ICON.info}<span>合法性標記說明</span></summary>
    <div class="legal-help__body">
      <ul>${["ok", "risky", "confirm"].map(k => `<li>${legalBadge(k)}<span>${esc(e[k] || "")}</span></li>`).join("")}</ul>
    </div>
  </details>`;
}

const disclaimerLine = () => (catalog.legal.disclaimer ? `<p class="disclaimer">${esc(catalog.legal.disclaimer)}</p>` : "");

/* ---------- option card ---------- */

function priceLine(option, { note = true } = {}) {
  const num = `<span class="price__num${option.price ? "" : " price__num--ask"}">${esc(formatPrice(option.price))}</span>`;
  const tag = `<span class="price__tag">參考價</span>`;
  const uncertain = isUnitUncertain(option);
  const unit = option.priceUnit
    ? `<span class="price__unit">${esc(option.priceUnit)}</span>`
    : uncertain ? `<span class="price__unit price__unit--warn">單顆或整組未確認</span>` : "";
  const basis = priceBasisLabel(option);
  const basisEl = basis ? `<small class="price__basis">${esc(basis)}</small>` : "";
  if (!note || !option.priceNote) return `<p class="price">${tag}${num}${unit}${basisEl}</p>`;
  if (uncertain || /^Shopee/.test(option.priceBasis)) return `<div class="price price--more"><p class="price__row">${tag}${num}${unit}${basisEl}</p><p class="price__note">${esc(option.priceNote)}</p></div>`;
  return `<details class="price price--more"><summary>${tag}${num}${unit}${basisEl}<span class="price__why">價格說明</span></summary><p class="price__note">${esc(option.priceNote)}</p></details>`;
}

/** 適用車款的提示（yearNote / note）與適配證據網址。 */
function fitsBlock(option, { summary = true } = {}) {
  const f = option.fits;
  const links = f.sources.map(safeUrl).filter(Boolean);
  return `<div class="opt__fit">
    ${summary ? `<p><span class="muted">適用車款</span>${esc(fitsSummary(catalog, option))}</p>` : ""}
    ${f.note ? `<p class="opt__yearnote"><strong>${f.universal ? "通用品限制" : "適用範圍"}</strong>${esc(f.note)}</p>` : ""}
    ${needsYearCheck(option, state.sel.type) ? `<p class="hint hint--year">${ICON.info}<span>請向賣家確認適用年份</span></p>` : ""}
    ${links.length ? `<details class="src"><summary>適配依據</summary>${links.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(hostOf(u) || u)}</a>`).join("")}</details>` : ""}
  </div>`;
}

function totalNotes(total) {
  const parts = [];
  if (total.inquiry) parts.push(`含 ${total.inquiry} 項詢價，未計入`);
  for (const u of total.units || []) parts.push(`${u.count} 項以「${u.unit}」整組價計入`);
  if (total.unitUncertain) parts.push(`${total.unitUncertain} 項價格單位依賣場標示（未必是整組），照標價計入、未自行乘以數量`);
  return parts;
}

function purchaseBlock(option) {
  const p = option.purchase;
  const url = safeUrl(p?.url);
  if (url) {
    const aff = p.isAffiliate === true;
    const shop = p.shop || shopLabel(option) || "商店";
    return `<div class="buy">
      <div class="buy__row">
        <a class="link-btn" href="${esc(url)}" target="_blank" rel="${aff ? "sponsored noopener noreferrer" : "noopener"}">${ICON.ext}<span>前往 ${esc(shop)}</span></a>
        ${aff ? `<small class="aff-tag">${esc(affiliateLabel(option))}</small>` : ""}
      </div>
      <small class="muted">連結僅供參考，台灣不一定買得到</small>
    </div>`;
  }
  if (p?.searchKeyword) return `<p class="hint">${ICON.search}<span>搜尋建議：${esc(p.searchKeyword)}</span></p>`;
  return "";
}

function affiliateLabel(option) {
  const shop = shopLabel(option);
  return shop === "蝦皮購物" ? "蝦皮分潤連結" : "分潤連結";
}

function sourceBlock(option) {
  const url = safeUrl(option.source);
  if (!url) return "";
  return `<details class="src"><summary>資料來源</summary><a href="${esc(url)}" target="_blank" rel="noopener">${esc(hostOf(url) || url)}</a></details>`;
}

function relationHints(option) {
  return option.relations.map(r => r.relation === "conflict"
    ? `<p class="hint hint--conf">${ICON.warn}<span>不可與「${esc(refLabel(catalog, r.id))}」同時安裝${r.note ? `：${esc(r.note)}` : ""}</span></p>`
    : `<p class="hint">${ICON.info}<span>建議搭配「${esc(refLabel(catalog, r.id))}」${r.note ? `：${esc(r.note)}` : ""}</span></p>`).join("");
}

function difficulty(option) {
  const n = option.installDifficulty;
  if (!n) return "";
  return `<span class="diff" aria-label="安裝難度 ${n}/3">安裝難度 <span class="dots">${[1, 2, 3].map(i => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span></span>`;
}

function pickButton(slot, option) {
  const cur = state.picks[slot.id];
  if (cur === option.id) {
    return `<button class="btn btn--picked" type="button" data-action="pick" data-slot="${esc(slot.id)}" data-option="${esc(option.id)}" aria-pressed="true">${ICON.check}已在清單・點此移除</button>`;
  }
  return `<button class="btn btn--primary" type="button" data-action="pick" data-slot="${esc(slot.id)}" data-option="${esc(option.id)}" aria-pressed="false">${cur ? "換成這款" : "加入清單"}</button>`;
}

function optionCard(slot, option) {
  const info = optionLegal(catalog, slot, option, state.sel.type);
  return `<article class="opt${state.picks[slot.id] === option.id ? " is-picked" : ""}">
    <div class="opt__top">
      <span class="opt__who"><span class="opt__brand">${esc(option.brand)}</span>${shopLabel(option) ? `<span class="opt__shop${option.purchase?.isAffiliate ? " opt__shop--aff" : ""}">${esc(shopLabel(option))}${option.purchase?.isAffiliate ? "・分潤" : ""}</span>` : ""}</span>
      ${optionBadge(info)}
    </div>
    ${overrideBlock(slot, option)}
    <h4 class="opt__name">${esc(option.name)}</h4>
    ${directionChips(option)}
    ${priceLine(option)}
    ${stockNoteBlock(option)}
    ${fitsBlock(option)}
    ${difficulty(option)}
    ${reviewBlock(option)}
    ${relationHints(option)}
    ${purchaseBlock(option)}
    ${sourceBlock(option)}
    <div class="opt__actions">${pickButton(slot, option)}</div>
  </article>`;
}

const pendingTag = () => `<span class="tag tag--empty">${PENDING}</span>`;

function pendingVehicleNotice() {
  if (!state.sel.vehicleId || vehicleHasParts()) return "";
  return `<div class="pending" role="note">${ICON.info}<div><strong>這款車的改裝品資料整理中</strong><p>目前只會列出通用品；改裝方向套組、部位清單與合法提醒仍可以查看。</p></div></div>`;
}

/* ---------- header / crumbs ---------- */

function renderHeader() {
  const { type, make, vehicle: v, year, gen } = selection();
  const cur = current();
  const idx = stepIndex(state.step);
  const values = [
    type ? typeLabel(type.type) : null,
    make ? make.nameZh || make.name : null,
    v?.model || null,
    year ? `${year}${gen?.name ? `・${gen.name}` : ""}` : null,
    year ? (cur && state.tab === "package" ? cur.theme.name : state.step === "parts" ? "自己挑" : cur?.theme.name || null) : null,
  ];
  const crumbs = values.map((val, i) => {
    const s = STEPS[i];
    const isCur = s.id === state.step || (i === 4 && state.step === "parts");
    if (!val && i > maxStepIndex()) return "";
    const aria = isCur ? ' aria-current="step"' : "";
    if (!val) return `<button class="crumb crumb--todo${isCur ? " is-current" : ""}" type="button" data-action="goto" data-step="${s.id}"${aria}>選擇${s.name}</button>`;
    return `<button class="crumb${isCur ? " is-current" : ""}" type="button" data-action="goto" data-step="${s.id}" aria-label="修改${s.name}：${esc(val)}"${aria}><span class="crumb__k">${s.name}</span><span class="crumb__v">${esc(val)}</span></button>`;
  }).join("");
  $("#crumbs").innerHTML = crumbs;
  $("#crumbs").hidden = !crumbs;
  $("#backBtn").hidden = idx === 0;
  $("#stepCount").textContent = `步驟 ${idx + 1}/${STEPS.length}・${STEPS[idx].name}`;
  $("#crumbs .is-current")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/* ---------- step views ---------- */

let vq = "";

function vehicleSearch(type) {
  const ph = type === "motorcycle" ? "例如：MMBCU、勁戰、DRG" : type === "car" ? "例如：Civic、RAV4、GR86" : "例如：Civic、RAV4、MMBCU、勁戰";
  return `<div class="vsearch" role="search">
    <label class="field field--search">
      <span class="sr-only">直接搜尋車款</span>
      <input id="vq" type="search" enterkeyhint="search" placeholder="直接搜尋車款，${esc(ph)}" value="${esc(vq)}" autocomplete="off" data-type="${esc(type || "")}">
    </label>
    <div id="vsResults" aria-live="polite">${vehicleResults(type)}</div>
  </div>`;
}

function vehicleResults(type) {
  if (!vq.trim()) return "";
  const hits = searchVehicles(catalog, vq, type || null);
  if (!hits.length) return `<p class="vsearch__empty">找不到「${esc(vq.trim())}」，試試英文車型名或車商名稱。</p>`;
  const shown = hits.slice(0, 20);
  return `<ul class="vsearch__list">${shown.map(v => {
    const g = v.gens;
    const span = g.length ? `${g[0].yearFrom}–${g[g.length - 1].ongoing ? "" : g[g.length - 1].yearTo}` : "";
    return `<li><button class="vs-item" type="button" data-action="pick-vehicle" data-id="${esc(v.id)}">
      <span class="vs-item__main"><span class="vs-item__title">${esc(v.makeZh || v.make)} ${esc(v.model)}</span>
      <span class="vs-item__meta">${esc(typeLabel(v.type))}・${esc(span)}</span></span>
      ${partsReady ? (hasVehicleParts(catalog, v.id) ? `<span class="tag tag--ok">有改裝品資料</span>` : pendingTag()) : ""}
      ${ICON.chev}
    </button></li>`;
  }).join("")}</ul>${hits.length > shown.length ? `<p class="vsearch__empty">還有 ${hits.length - shown.length} 款，請再多打幾個字縮小範圍。</p>` : ""}`;
}

function viewLoadingParts() {
  if (partsError) return errorView(partsError);
  return `<section class="view"><div class="loading"><span class="spinner" aria-hidden="true"></span><p>正在載入改裝品資料…</p></div></section>`;
}

function errorView(err) {
  return `<div class="empty empty--error" role="alert">
    <h1 class="view__title" tabindex="-1">資料載入失敗</h1>
    <p>${esc(err.message)}</p>
    <p class="muted">${location.protocol === "file:" ? "請用本機伺服器開啟（例如 python3 -m http.server），直接點開檔案無法讀取資料。" : "請檢查網路連線後再試一次。"}</p>
    <button class="btn btn--primary" type="button" onclick="location.reload()">重新載入</button>
  </div>`;
}

function viewType() {
  return `<section class="view">
    <p class="eyebrow">第一步</p>
    <h1 class="view__title" tabindex="-1">你要改的是哪一種車？</h1>
    <p class="lead">選好車種、車商、車款與年式，只會顯示適用你這台車的部位與改裝品。</p>
    ${vehicleSearch(null)}
    <div class="grid grid--2">
      ${catalog.types.map(t => `<button class="card card--type${state.sel.type === t.type ? " is-selected" : ""}" type="button" data-action="type" data-id="${esc(t.type)}">
        <span class="card__art">${ICON[t.type] || ICON.car}</span>
        <span class="card__title">${esc(typeLabel(t.type))}</span>
        <span class="card__meta">${t.makes.length} 個車商・${t.makes.reduce((n, m) => n + m.vehicles.length, 0)} 款車</span>
      </button>`).join("")}
    </div>
  </section>`;
}

function viewMake() {
  const { type } = selection();
  return `<section class="view">
    <p class="eyebrow">${esc(typeLabel(type?.type))}</p>
    <h1 class="view__title" tabindex="-1">選擇車商</h1>
    ${vehicleSearch(type?.type)}
    <div class="grid grid--makes">
      ${(type?.makes || []).map(m => `<button class="card card--make${state.sel.makeKey === m.key ? " is-selected" : ""}" type="button" data-action="make" data-id="${esc(m.key)}">
        <span class="card__title">${esc(m.nameZh && m.nameZh !== m.name ? m.nameZh : m.name)}</span>
        <span class="card__meta">${m.nameZh && m.nameZh !== m.name ? `${esc(m.nameEn || m.name)}・` : ""}${m.vehicles.length} 款</span>
      </button>`).join("")}
    </div>
  </section>`;
}

function genRange(g) {
  return `${g.yearFrom}–${g.ongoing ? "" : g.yearTo}${g.ongoing ? "（仍在產）" : ""}`;
}

function viewModel() {
  const { make } = selection();
  return `<section class="view">
    <p class="eyebrow">${esc(make?.name)}</p>
    <h1 class="view__title" tabindex="-1">選擇車款</h1>
    <div class="grid grid--list">
      ${(make?.vehicles || []).map(v => {
        const first = v.gens[0];
        const last = v.gens[v.gens.length - 1];
        const span = first ? `${first.yearFrom}–${last.ongoing ? "" : last.yearTo}` : "";
        return `<button class="card card--row card--model${state.sel.vehicleId === v.id ? " is-selected" : ""}" type="button" data-action="model" data-id="${esc(v.id)}">
          <span class="card__main">
            <span class="card__title">${esc(v.model)}</span>
            <span class="card__meta">${v.gens.length} 個世代・${esc(span)}</span>
          </span>
          ${hasVehicleParts(catalog, v.id) ? `<span class="tag tag--ok">有改裝品資料</span>` : pendingTag()}
          ${ICON.chev}
        </button>`;
      }).join("")}
    </div>
  </section>`;
}

function viewYear() {
  const { make, vehicle: v } = selection();
  const gens = [...(v?.gens || [])].reverse();
  return `<section class="view">
    <p class="eyebrow">${esc(make?.name)} ${esc(v?.model)}</p>
    <h1 class="view__title" tabindex="-1">選擇年式</h1>
    <p class="lead">年式依世代展開；世代之間可能有重疊年份，請選擇你的車所屬的世代。</p>
    ${v?.note ? `<details class="src src--block"><summary>年式怎麼推估的？</summary><p>${esc(v.note)}</p>${safeUrl(v.source) ? `<a href="${esc(safeUrl(v.source))}" target="_blank" rel="noopener">${esc(hostOf(v.source))}</a>` : ""}</details>` : ""}
    ${gens.map(g => `<section class="gen">
      <div class="gen__head">
        <h2 class="gen__name">${esc(g.name)}</h2>
        <span class="gen__range">${esc(genRange(g))}</span>
        ${g.uncertain ? `<span class="tag tag--warn">年式為推估</span>` : ""}
      </div>
      ${g.note ? `<p class="gen__note">${esc(g.note)}</p>` : ""}
      <div class="grid grid--years">
        ${g.years.map(y => {
          const on = Number(state.sel.year) === y && Number(state.sel.gen) === g.index;
          return `<button class="chip-btn${on ? " is-selected" : ""}" type="button" data-action="year" data-id="${y}" data-gen="${g.index}" aria-label="${y} 年式（${esc(g.name)}）">${y}</button>`;
        }).join("")}
      </div>
    </section>`).join("")}
  </section>`;
}

function directionCards() {
  const list = themesForType(catalog, state.sel.type);
  if (!list.length) return `<div class="empty"><p>這個車種目前沒有建議套組，可以直接自己挑改裝品。</p></div>`;
  return `<div class="grid grid--dirs">
    ${list.map(({ theme, variant }) => {
      const counts = tierIds(variant).map(t => `${tierName(variant, t)} ${resolveTierItems(variant, t).filter(i => catalog.slotById.has(i.slotId)).length} 項`);
      return `<button class="card card--dir${state.themeId === theme.id ? " is-selected" : ""}" type="button" data-action="direction" data-id="${esc(theme.id)}">
        <span class="card__title">${esc(theme.name)}</span>
        <span class="card__desc">${esc(theme.description || "")}</span>
        <span class="card__meta">${esc(counts.join("・"))}</span>
      </button>`;
    }).join("")}
  </div>`;
}

function viewDirection() {
  return `<section class="view">
    <p class="eyebrow">${esc(vehicleName())}</p>
    <h1 class="view__title" tabindex="-1">想往哪個方向改？</h1>
    ${pendingVehicleNotice()}
    <p class="lead">每個方向分入門、進階、極致三級，較高等級會包含前一級的項目。也可以不選方向自己挑。</p>
    ${directionCards()}
    <button class="btn btn--ghost btn--block" type="button" data-action="browse">不選方向，直接自己挑改裝品</button>
  </section>`;
}

function viewParts() {
  const cur = current();
  const tabs = `<div class="tabs" role="tablist" aria-label="改裝品顯示方式">
    <button class="tab" role="tab" type="button" data-action="tab" data-id="package" aria-selected="${state.tab === "package"}">建議套組</button>
    <button class="tab" role="tab" type="button" data-action="tab" data-id="browse" aria-selected="${state.tab === "browse"}">自己挑改裝品</button>
  </div>`;
  return `<section class="view">
    <p class="eyebrow">${esc(vehicleName())}</p>
    <h1 class="view__title" tabindex="-1">${state.tab === "package" && cur ? `${esc(cur.theme.name)}套組` : "挑選改裝品"}</h1>
    ${pendingVehicleNotice()}
    <p class="notice">${ICON.info}<span>價格為參考價，購買前請向廠商確認適配。</span></p>
    ${tabs}
    <div class="tabpanel">${state.tab === "package" ? packagePanel() : browsePanel()}</div>
  </section>`;
}

function budgetDots(level) {
  const n = Number(level) || 0;
  if (!n) return "";
  return `<span class="dots" aria-label="預算等級 ${n}/3">${[1, 2, 3].map(i => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`;
}

function inquiryNote(total) {
  return totalNotes(total).map(t => `<p class="budget__ask">${esc(t)}</p>`).join("");
}

function packagePanel() {
  const cur = current();
  if (!cur) return `<p class="lead">先選一個改裝方向，就會列出建議套組。</p>${directionCards()}`;
  const { variant } = cur;
  const ids = tierIds(variant);
  if (!ids.includes(state.tier)) state.tier = ids[0];
  const tier = variant.tiers[state.tier] || {};
  const plan = tierPlan(catalog, variant, state.tier, vehicle(), state.picks, state.themeId);
  const withOpts = plan.filter(p => p.shown);
  const total = sumPrices(withOpts.map(p => p.shown));
  const pending = plan.length - withOpts.length;
  const allIn = withOpts.length > 0 && withOpts.every(p => state.picks[p.slot.id] === p.shown.id);
  const tierTabs = `<div class="seg" role="tablist" aria-label="套組等級">${ids.map(t =>
    `<button class="seg__btn" role="tab" type="button" data-action="tier" data-id="${esc(t)}" aria-selected="${state.tier === t}">${esc(tierName(variant, t))}</button>`).join("")}</div>`;
  const includesName = tier.includes ? tierName(variant, tier.includes) : "";

  return `${tierTabs}
    ${variant.note ? `<p class="dir-desc">${esc(variant.note)}</p>` : ""}
    <div class="budget">
      <div class="budget__main">
        <p class="budget__label">${esc(tierName(variant, state.tier))}套組・預算等級 ${budgetDots(tier.budgetLevel)}</p>
        <p class="budget__num">${total.priced ? esc(formatPrice({ min: total.min, max: total.max })) : "尚無報價"}</p>
        ${inquiryNote(total)}
        <p class="budget__meta">共 ${plan.length} 個部位${includesName ? `（含${esc(includesName)}全部項目）` : ""}${total.priced ? `・${total.priced} 個部位有參考價` : ""}${pending ? `・${pending} 個部位${PENDING}，未計入` : ""}</p>
        ${tier.budgetNote ? `<p class="budget__note">${esc(tier.budgetNote)}</p>` : ""}
      </div>
      <button class="btn btn--primary btn--lg" type="button" data-action="add-all"${allIn || !withOpts.length ? " disabled" : ""}>${allIn ? `${ICON.check}整套已在清單` : withOpts.length ? "整套加入清單" : "尚無可加入的品項"}</button>
    </div>
    ${disclaimerLine()}
    ${legalHelp()}
    ${plan.length ? `<ol class="pkg">
      ${plan.map(p => {
        const { slot, shown, why, priority, options, custom } = p;
        const info = shown ? optionLegal(catalog, slot, shown, state.sel.type) : slotLegal(catalog, slot.id, state.sel.type);
        return `<li class="pkg-item${shown && state.picks[slot.id] === shown.id ? " is-picked" : ""}">
          <div class="pkg-item__head">
            <span class="pkg-item__prio" aria-label="建議順序">${esc(priority)}</span>
            <span class="pkg-item__slot">${esc(slot.name)}</span>
            <span class="pkg-item__cat">${esc(slot.category)}</span>
          </div>
          ${why ? `<p class="why"><strong>為什麼推薦</strong>${esc(why)}</p>` : ""}
          <div class="pkg-item__meta">${optionBadge(info)}${shown ? "" : pendingTag()}</div>
          ${slotLegalBlock(slot)}
          ${shown ? `<div class="pkg-item__pick">
              <p class="pkg-item__opt"><span class="opt__brand">${esc(shown.brand)}</span> ${esc(shown.name)}</p>
              ${custom ? `<p class="hint">${ICON.info}<span>已換成你挑的款式</span></p>` : ""}
              ${priceLine(shown)}
              ${fitsBlock(shown, { summary: false })}
              ${overrideBlock(slot, shown)}
            </div>
            <div class="pkg-item__actions">
              ${pickButton(slot, shown)}
              <button class="btn btn--ghost" type="button" data-action="compare" data-slot="${esc(slot.id)}">比較款式（${options.length}）</button>
            </div>` : `<p class="pending-line">這個部位的品牌選項${PENDING}，之後會補上。</p>`}
        </li>`;
      }).join("")}
    </ol>` : `<div class="empty"><p>這個等級目前沒有適用此車種的項目。</p></div>`}`;
}

const filtersActive = () => JSON.stringify(state.filters) !== JSON.stringify(DEFAULT_FILTERS);

function catChips() {
  const facets = availableFacets(catalog, vehicle());
  const total = facets.categories.reduce((n, c) => n + c.count, 0);
  const chip = (id, label, n) => `<button class="cat-chip${state.filters.category === id ? " is-on" : ""}" type="button" data-action="cat" data-id="${esc(id)}" aria-pressed="${state.filters.category === id}">${esc(label)}<span>${n}</span></button>`;
  return chip("all", "全部", total) + facets.categories.map(c => chip(c.name, c.name, c.count)).join("");
}

function browsePanel() {
  const f = state.filters;
  const facets = availableFacets(catalog, vehicle());
  const opt = (v, label, cur) => `<option value="${esc(v)}"${cur === v ? " selected" : ""}>${esc(label)}</option>`;
  return `<div class="filters" role="search">
      <label class="field field--search">
        <span class="sr-only">搜尋部位或改裝品</span>
        <input id="q" type="search" enterkeyhint="search" placeholder="搜尋部位、品牌或品名，例如：來令片" value="${esc(f.q)}" autocomplete="off">
      </label>
      <div class="cat-chips" id="catChips" role="group" aria-label="分類">${catChips()}</div>
      <div class="filters__row">
        <label class="field"><span class="field__label">價格</span>
          <select data-filter="price">${PRICE_BUCKETS.map(b => opt(b.id, b.name, f.price)).join("")}</select>
        </label>
        <label class="field"><span class="field__label">品牌</span>
          <select data-filter="brand">${opt("all", facets.brands.length ? "全部品牌" : "尚無品牌", f.brand)}${facets.brands.map(b => opt(b, b, f.brand)).join("")}</select>
        </label>
      </div>
      <label class="switch">
        <input type="checkbox" data-filter="legalOnly"${f.legalOnly ? " checked" : ""}>
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label">只看沒有合法疑慮的</span>
      </label>
      ${disclaimerLine()}
      ${legalHelp()}
    </div>
    <div id="results" aria-live="polite">${resultsHtml()}</div>`;
}

/** 長清單分段：每個部位先畫前幾款（已選的那款一定顯示），其餘按鈕展開，篩選與搜尋結果不變。 */
function foldedOptions(slot, options) {
  const open = expandedSlots.has(slot.id);
  const shown = open ? options : options.filter((o, i) => i < FOLD_AT || state.picks[slot.id] === o.id);
  const rest = options.length - shown.length;
  const restUniversal = options.filter(o => o.fits.universal && !shown.includes(o)).length;
  return `${groupedCards(slot, shown)}
    ${rest ? `<button class="btn btn--ghost btn--block more-btn" type="button" data-action="expand-slot" data-slot="${esc(slot.id)}">顯示其餘 ${rest} 款${restUniversal ? `（含 ${restUniversal} 款通用品）` : ""}</button>` : ""}`;
}

/** 車款專用品在前，通用品另成一區。 */
function groupedCards(slot, options) {
  const own = options.filter(o => !o.fits.universal);
  const uni = options.filter(o => o.fits.universal);
  return `${own.length ? `<div class="opt-grid">${own.map(o => optionCard(slot, o)).join("")}</div>` : ""}
    ${uni.length ? `<h4 class="opt-group">通用品<span>不限車款，請看各款的限制條件</span></h4><div class="opt-grid">${uni.map(o => optionCard(slot, o)).join("")}</div>` : ""}`;
}

function brandTag(options) {
  const b = brandSummary(options);
  if (b.brands !== 1) return "";
  return `<span class="tag tag--one">${b.options === 1 ? "目前只找到 1 款" : "目前只找到 1 個品牌"}</span>`;
}

function directionChips(option) {
  if (!option.directionTags.length) return "";
  const names = option.directionTags.map(id => catalog.themes.find(t => t.id === id)).filter(Boolean);
  if (!names.length) return "";
  return `<p class="dir-tags"><span class="muted">適合方向</span>${names.map(t => `<span class="dir-tag${t.id === state.themeId ? " is-on" : ""}">${esc(t.name)}</span>`).join("")}</p>`;
}

function stockNoteBlock(option) {
  if (!option.stockNote) return "";
  return `<p class="hint hint--stock">${ICON.warn}<span>${esc(option.stockNote)}</span></p>`;
}

function reviewBlock(option) {
  const r = option.reviewNote;
  if (!r) return "";
  const url = safeUrl(r.source);
  return `<blockquote class="review"><p><strong>車評說法</strong>${esc(r.text)}</p>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">出處：${esc(hostOf(url) || url)}</a>` : ""}</blockquote>`;
}

function resultsHtml() {
  const groups = filterCatalog(catalog, vehicle(), state.filters, state.themeId);
  const slotCount = groups.reduce((n, g) => n + g.slots.length, 0);
  const optCount = groups.reduce((n, g) => n + g.slots.reduce((m, s) => m + s.options.length, 0), 0);
  const clear = filtersActive() ? '<button class="link" type="button" data-action="clear-filters">清除篩選</button>' : "";
  if (!slotCount) {
    return `<div class="empty"><p>沒有符合條件的部位或改裝品。</p>${clear ? '<button class="btn btn--ghost" type="button" data-action="clear-filters">清除篩選條件</button>' : ""}</div>`;
  }
  return `<p class="result-count">${slotCount} 個部位・${optCount} 款改裝品 ${clear}</p>
    ${groups.map(g => `<section class="cat">
      <h2 class="cat__title">${esc(g.category)}<span>${g.slots.length}</span></h2>
      ${g.slots.map(({ slot, options, total }) => {
        const sl = slotLegal(catalog, slot.id, state.sel.type);
        return `<div class="slot${options.length ? "" : " slot--empty"}">
          <div class="slot__head">
            <h3 class="slot__name">${esc(slot.name)}</h3>
            ${legalBadge(sl?.legal)}
            ${total ? `<span class="slot__count">${options.length < total ? `${options.length}/${total}` : total} 款</span>${brandTag(options)}` : pendingTag()}
          </div>
          ${slotLegalBlock(slot)}
          ${options.length ? foldedOptions(slot, options) : ""}
        </div>`;
      }).join("")}
    </section>`).join("")}`;
}

/* ---------- sheets ---------- */

function openSheet(id) {
  const d = document.getElementById(id);
  if (!d.open) d.showModal();
  d.querySelector(".sheet__body").scrollTop = 0;
}

function renderSlotSheet(slotId) {
  const slot = catalog.slotById.get(slotId);
  if (!slot) return;
  const options = compatibleOptions(slot, vehicle(), state.themeId);
  const sl = slotLegal(catalog, slot.id, state.sel.type);
  $("#slotSheet").dataset.slot = slotId;
  $("#slotSheetTitle").textContent = `比較：${slot.name}`;
  $("#slotSheetBody").innerHTML = `<p class="muted sheet__sub">${esc(slot.category)}・同一部位只會保留一款，換款式會自動替換並重算總預算。</p>
    <div class="pkg-item__meta">${legalBadge(sl?.legal)}${brandTag(options)}</div>
    ${slotLegalBlock(slot, { open: true })}
    ${options.length ? groupedCards(slot, options) : `<div class="empty"><p>${pendingTag()}</p><p class="muted">這個部位適用此車款的品牌選項${PENDING}。</p></div>`}`;
}

function renderListSheet() {
  const entries = pickedEntries(catalog, state.picks);
  const total = sumPrices(entries.map(e => e.option));
  const issues = checkIssues(catalog, state.picks);
  const byCat = new Map();
  for (const e of entries) {
    if (!byCat.has(e.slot.category)) byCat.set(e.slot.category, []);
    byCat.get(e.slot.category).push(e);
  }
  const cats = sortedCategories(catalog, [...byCat.keys()]);
  const canPick = id => id && compatibleOptions(catalog.slotById.get(id), vehicle()).length;
  const noteText = n => (n ? `<span class="muted">${esc(n)}</span>` : "");

  const issueHtml = issues.length ? `<div class="issues">
      <h3 class="issues__title">${ICON.warn}清單提醒（${issues.length}）</h3>
      <ul>${issues.map(i => i.type === "conflict"
        ? `<li class="issue"><p>「${esc(i.a.slot.name)}：${esc(i.a.option.name)}」與「${esc(i.b.slot.name)}：${esc(i.b.option.name)}」不建議同時安裝。${noteText(i.note)}</p>
            <div class="issue__actions"><button class="btn btn--sm" type="button" data-action="remove" data-slot="${esc(i.b.slot.id)}">移除${esc(i.b.slot.name)}</button><button class="btn btn--sm" type="button" data-action="remove" data-slot="${esc(i.a.slot.id)}">移除${esc(i.a.slot.name)}</button></div></li>`
        : `<li class="issue"><p>「${esc(i.a.option.name)}」建議搭配「${esc(i.label)}」。${noteText(i.note)}</p>
            ${canPick(i.slotId)
              ? `<div class="issue__actions"><button class="btn btn--sm btn--primary" type="button" data-action="compare" data-slot="${esc(i.slotId)}">去挑${esc(catalog.slotById.get(i.slotId).name)}</button></div>`
              : `<p class="muted">此車款可搭配的品牌選項${PENDING}，請向廠商確認。</p>`}</li>`).join("")}</ul>
    </div>` : "";

  $("#listSheetBody").innerHTML = `
    <p class="sheet__sub">${state.sel.year ? esc(vehicleName()) : "尚未選擇車款"}</p>
    ${entries.length ? `
      <div class="list-total">
        <span>共 ${entries.length} 件</span>
        <strong>參考價合計 ${total.priced ? esc(formatPrice({ min: total.min, max: total.max })) : "—"}</strong>
        ${totalNotes(total).map(t => `<span class="budget__ask">${esc(t)}</span>`).join("")}
      </div>
      ${issueHtml}
      ${cats.map(c => `<section class="list-cat"><h3>${esc(c)}</h3><ul class="list-items">
        ${byCat.get(c).map(({ slot, option }) => {
          const info = optionLegal(catalog, slot, option, state.sel.type);
          return `<li class="list-item">
          <div class="list-item__main">
            <p class="list-item__slot">${esc(slot.name)}</p>
            <p class="list-item__name"><span class="opt__brand">${esc(option.brand)}</span> ${esc(option.name)}</p>
            <div class="list-item__meta">${priceLine(option)}${optionBadge(info)}</div>
            ${overrideBlock(slot, option)}
            ${info?.override ? "" : slotLegalBlock(slot)}
            ${purchaseBlock(option)}
          </div>
          <div class="list-item__actions">
            <button class="btn btn--sm" type="button" data-action="compare" data-slot="${esc(slot.id)}">換款式</button>
            <button class="btn btn--sm btn--danger" type="button" data-action="remove" data-slot="${esc(slot.id)}">移除</button>
          </div>
        </li>`;
        }).join("")}
      </ul></section>`).join("")}
      <p class="notice">${ICON.info}<span>價格為參考價，購買前請向廠商確認適配。</span></p>
      ${disclaimerLine()}
      <div class="share">
        <h3 class="share__title">分享這份清單</h3>
        <p class="muted">連結會包含車款與清單內容，對方打開就能看到一樣的清單。</p>
        <div class="share__row">
          <input id="shareUrl" type="text" readonly value="${esc(shareUrl())}" aria-label="分享連結">
          <button class="btn btn--primary" type="button" data-action="copy-share">複製連結</button>
        </div>
        ${navigator.share ? '<button class="btn btn--ghost btn--block" type="button" data-action="native-share">用其他 App 分享</button>' : ""}
      </div>
      <button class="btn btn--ghost btn--block" type="button" data-action="clear-list">清空清單</button>
    ` : `<div class="empty"><p>清單還是空的。</p><p class="muted">${state.sel.vehicleId && !vehicleHasParts() ? "這款車的改裝品資料整理中，目前只能加入通用品。" : "在建議套組按「整套加入清單」，或在改裝品卡片按「加入清單」。"}</p>
      ${state.sel.year ? '<button class="btn btn--primary" type="button" data-action="close-list">去挑改裝品</button>' : ""}</div>`}
  `;
}

const shareUrl = () => `${location.origin}${location.pathname}#${encodeShare(state)}`;

/* ---------- dock ---------- */

function renderDock() {
  const total = sumPicks(catalog, state.picks);
  const issues = checkIssues(catalog, state.picks);
  const show = !!state.sel.year || total.count > 0;
  $("#dock").hidden = !show;
  document.body.classList.toggle("has-dock", show);
  $("#dockCount").textContent = total.count;
  $("#dockTotal").textContent = !total.count ? "還沒有加入改裝品" : total.priced ? formatPrice({ min: total.min, max: total.max }) : "詢價";
  $("#dockLabel").textContent = total.count ? `我的清單・參考價${total.inquiry ? `（${total.inquiry} 項詢價未計）` : ""}` : "我的改裝清單";
  const warn = $("#dockWarn");
  warn.hidden = !issues.length;
  warn.textContent = issues.length ? `${issues.length} 個提醒` : "";
}

/* ---------- render ---------- */

function syncSheets() {
  if ($("#slotSheet").open) renderSlotSheet($("#slotSheet").dataset.slot);
  if ($("#listSheet").open) renderListSheet();
}

function render({ focus = false } = {}) {
  state.step = clampStep(state.step);
  renderHeader();
  const views = { type: viewType, make: viewMake, model: viewModel, year: viewYear, direction: viewDirection, parts: viewParts };
  main.innerHTML = partsReady || stepIndex(state.step) <= 1 ? views[state.step]() : viewLoadingParts();
  renderDock();
  syncSheets();
  if (focus) {
    window.scrollTo({ top: 0 });
    $(".view__title", main)?.focus({ preventScroll: true });
  }
  save();
}

function refreshResults() {
  const r = $("#results");
  if (!r) return render();
  r.innerHTML = resultsHtml();
  const chips = $("#catChips");
  if (chips) chips.innerHTML = catChips();
  save();
}

function refreshInPlace() {
  const y = window.scrollY;
  if (state.step === "parts" && state.tab === "browse" && $("#results")) {
    refreshResults();
    renderHeader();
    renderDock();
    syncSheets();
  } else {
    render();
  }
  window.scrollTo({ top: y });
}

function go(step, { push = true } = {}) {
  state.step = clampStep(step);
  if (push) history.pushState({ step: state.step }, "", location.pathname + location.search);
  render({ focus: true });
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("is-on"), 3200);
}

function applyVehicleChange() {
  const { picks, removed } = pruneIncompatible(catalog, state.picks, vehicle());
  state.picks = picks;
  if (!findVariant(catalog, state.themeId, state.sel.type)) state.themeId = null;
  if (removed.length) toast(`已移除 ${removed.length} 件不適用新車款的改裝品`);
}

function togglePick(slotId, optionId) {
  const slot = catalog.slotById.get(slotId);
  const hit = catalog.optionById.get(optionId);
  if (!slot || !hit) return;
  const prev = state.picks[slotId];
  if (prev === optionId) {
    delete state.picks[slotId];
    toast(`已從清單移除「${slot.name}」`);
    return;
  }
  state.picks[slotId] = optionId;
  const related = checkIssues(catalog, state.picks).filter(i => i.a.option.id === optionId || i.b?.option.id === optionId);
  const base = prev ? `已將「${slot.name}」換成 ${hit.option.brand} ${hit.option.name}，總預算已重算` : `已加入 ${hit.option.brand} ${hit.option.name}`;
  toast(related.length ? `${base}。有 ${related.length} 個搭配提醒，請打開清單查看` : base);
}

/* ---------- events ---------- */

document.addEventListener("click", e => {
  const el = e.target.closest("[data-action]");
  if (!el || el.disabled) return;
  const { action, id, step, slot, option, gen } = el.dataset;
  switch (action) {
    case "goto": go(step); break;
    case "type":
      if (state.sel.type !== id) state.sel = { ...EMPTY_SEL, type: id };
      go("make"); break;
    case "make":
      if (state.sel.makeKey !== id) Object.assign(state.sel, { makeKey: id, vehicleId: null, year: null, gen: null });
      go("model"); break;
    case "model":
      if (state.sel.vehicleId !== id) Object.assign(state.sel, { vehicleId: id, year: null, gen: null });
      go("year"); break;
    case "pick-vehicle": {
      const v = catalog.vehicleById.get(id);
      if (!v) break;
      if (state.sel.vehicleId !== id) state.sel = { ...EMPTY_SEL, type: v.type, makeKey: makeKeyOf(v), vehicleId: id };
      vq = "";
      go("year"); break;
    }
    case "year":
      Object.assign(state.sel, { year: Number(id), gen: Number(gen) });
      applyVehicleChange();
      state.filters = { ...DEFAULT_FILTERS };
      go("direction"); break;
    case "direction":
      if (state.themeId !== id) state.tier = "starter";
      state.themeId = id;
      state.tab = "package";
      go("parts"); break;
    case "browse":
      state.tab = "browse";
      go("parts"); break;
    case "tab":
      state.tab = id;
      render(); break;
    case "tier":
      state.tier = id;
      render(); break;
    case "cat":
      state.filters.category = id;
      refreshResults(); break;
    case "pick":
      togglePick(slot, option);
      refreshInPlace(); break;
    case "remove":
      if (state.picks[slot]) { delete state.picks[slot]; toast(`已從清單移除「${catalog.slotById.get(slot)?.name || ""}」`); }
      refreshInPlace(); break;
    case "add-all": {
      const cur = current();
      if (!cur) break;
      const plan = tierPlan(catalog, cur.variant, state.tier, vehicle(), state.picks, state.themeId);
      let n = 0;
      for (const p of plan) {
        if (p.shown && state.picks[p.slot.id] !== p.shown.id) { state.picks[p.slot.id] = p.shown.id; n++; }
      }
      const pending = plan.filter(p => !p.shown).length;
      const issues = checkIssues(catalog, state.picks).length;
      toast(`已加入 ${n} 件${pending ? `，${pending} 個部位${PENDING}未加入` : ""}${issues ? `。清單有 ${issues} 個搭配提醒` : ""}`);
      refreshInPlace(); break;
    }
    case "compare":
      renderSlotSheet(slot);
      openSheet("slotSheet"); break;
    case "expand-slot":
      expandedSlots.add(slot);
      refreshResults(); break;
    case "clear-filters":
      state.filters = { ...DEFAULT_FILTERS };
      render(); break;
    case "copy-share": copyShare(); break;
    case "native-share":
      navigator.share({ title: "我的改裝清單", text: vehicleName(), url: shareUrl() }).catch(() => {});
      break;
    case "clear-list":
      if (confirm("確定要清空整份清單嗎？")) { state.picks = {}; toast("清單已清空"); refreshInPlace(); }
      break;
    case "close-list":
      $("#listSheet").close();
      if (state.step !== "parts") go("parts");
      break;
  }
});

async function copyShare() {
  const input = $("#shareUrl");
  const url = shareUrl();
  input.value = url;
  try {
    await navigator.clipboard.writeText(url);
    toast("已複製分享連結");
  } catch {
    input.focus();
    input.select();
    toast("請長按連結手動複製");
  }
}

$("#backBtn").addEventListener("click", () => {
  const idx = stepIndex(state.step);
  if (idx > 0) go(STEPS[idx - 1].id);
});

$("#dockBtn").addEventListener("click", () => {
  renderListSheet();
  openSheet("listSheet");
});

for (const d of document.querySelectorAll("dialog.sheet")) {
  d.addEventListener("click", e => {
    if (e.target === d || e.target.closest("[data-close]")) d.close();
  });
}

let qTimer;
document.addEventListener("input", e => {
  if (e.target.id === "vq") {
    vq = e.target.value;
    const r = $("#vsResults");
    if (r) r.innerHTML = vehicleResults(e.target.dataset.type);
    return;
  }
  if (e.target.id !== "q") return;
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { state.filters.q = e.target.value; refreshResults(); }, 150);
});

document.addEventListener("change", e => {
  const key = e.target.dataset?.filter;
  if (!key) return;
  state.filters[key] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
  refreshResults();
});

window.addEventListener("popstate", e => {
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
  state.step = clampStep(e.state?.step || "type");
  render({ focus: true });
});

/* ---------- boot ---------- */

const BASE_FILES = ["vehicles.json", "slots.json", "themes.json", "legal-notes.json"];

async function fetchJson(name) {
  const res = await fetch(`data/${name}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`data/${name} 讀取失敗（HTTP ${res.status}）`);
  try { return await res.json(); } catch { throw new Error(`data/${name} 不是有效的 JSON`); }
}

function storedNeedsParts() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return !!raw && (stepIndex(raw.step) > 1 || Object.keys(raw.picks || {}).length > 0);
  } catch { return false; }
}

function applyCatalogMeta() {
  if (catalog.orphanPartSlots.length) {
    console.info("[改裝規劃室] parts.json 有 slots.json 沒有的 slotId，已略過：", catalog.orphanPartSlots.join(", "));
  }
  if (catalog.note) {
    $("#sampleBanner").textContent = catalog.note;
    $("#sampleBanner").hidden = false;
  }
  $("#affiliateNote").hidden = !catalog.hasAffiliate;
  if (catalog.legal.disclaimer) $("#footerDisclaimer").textContent = catalog.legal.disclaimer;
}

function startFromStorage() {
  load();
  const shared = decodeShare(location.hash, catalog);
  if (shared) {
    Object.assign(state, shared);
    if (state.sel.vehicleId) state.picks = pruneIncompatible(catalog, state.picks, vehicle()).picks;
    state.tab = state.themeId ? "package" : "browse";
    state.step = clampStep("parts");
    history.replaceState({ step: state.step }, "", location.pathname + location.search);
    render({ focus: true });
    renderListSheet();
    openSheet("listSheet");
    toast("已載入分享的改裝清單");
  } else {
    history.replaceState({ step: state.step }, "", location.pathname + location.search + location.hash);
    render({ focus: true });
  }
}

/**
 * parts.json 最大（約 1.6 MB），一開始就背景下載；車種、車商與車款搜尋只需要小檔，
 * 先畫出來。有分享連結或上次已選到車款以後的步驟時，等 parts 到齊再還原。
 */
async function boot() {
  const partsP = fetchJson("parts.json");
  partsP.catch(() => {});
  let base;
  try {
    const [vehicles, slotsData, themes, legalNotes] = await Promise.all(BASE_FILES.map(fetchJson));
    base = { vehicles, slotsData, themes, legalNotes };
  } catch (err) {
    main.innerHTML = errorView(err);
    return;
  }

  const waitParts = location.hash.length > 1 || storedNeedsParts();
  if (!waitParts) {
    catalog = buildCatalog({ ...base, parts: null });
    applyCatalogMeta();
    startFromStorage();
  }
  try {
    catalog = buildCatalog({ ...base, parts: await partsP });
    partsReady = true;
  } catch (err) {
    partsError = err;
    if (waitParts) { main.innerHTML = errorView(err); return; }
    if (stepIndex(state.step) > 1) render();
    return;
  }
  applyCatalogMeta();
  if (waitParts) return startFromStorage();
  if (stepIndex(state.step) > 1) return render();
  const r = $("#vsResults");
  if (r) r.innerHTML = vehicleResults($("#vq")?.dataset.type);
}

boot();
