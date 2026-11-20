import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { enable as autoOn, disable as autoOff, isEnabled as autoIsOn } from "@tauri-apps/plugin-autostart";

// ---------- model ----------
type Clock = { id: string; tz: string; city: string; label: string; start: number; end: number };
type Theme = "system" | "light" | "dark";
type Settings = {
  home: Clock;
  clocks: Clock[];
  hour12: boolean;
  theme: Theme;
  opacity: number; // background opacity, 30–100 (%)
  alwaysOnTop: boolean;
  defaultStart: number;
  defaultEnd: number;
  compact: boolean;
};

const STORE = "worldclock.v2";
const OLD_STORE = "worldclock.v1";
const inTauri = "__TAURI_INTERNALS__" in window;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
const cityOf = (tz: string) => tz.split("/").pop()!.replace(/_/g, " ");
// Windows/ICU sometimes report retired IANA names; show the current ones.
const LEGACY: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata", "Asia/Saigon": "Asia/Ho_Chi_Minh", "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon", "Europe/Kiev": "Europe/Kyiv", "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
};
const canon = (tz: string) => LEGACY[tz] ?? tz;
const mkClock = (tz: string, label = "", start = 9, end = 18, city = cityOf(tz)): Clock => ({ id: uid(), tz, city, label, start, end });

function defaults(): Settings {
  const sysTz = canon(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  return {
    home: mkClock(sysTz, "Home"),
    clocks: [mkClock("Europe/London"), mkClock("America/New_York")].filter((c) => c.tz !== sysTz),
    hour12: false, theme: "system", opacity: 85, alwaysOnTop: true,
    defaultStart: 9, defaultEnd: 18, compact: false,
  };
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) return { ...defaults(), ...JSON.parse(raw) };
    const old = localStorage.getItem(OLD_STORE); // migrate the first prototype's list
    if (old) {
      const o = JSON.parse(old) as { zones: any[]; compact: boolean };
      const toClock = (z: any) => mkClock(z.tz, z.label, z.start ?? 9, z.end ?? 18, z.city);
      const h = o.zones.find((z) => z.home) ?? o.zones[0];
      return { ...defaults(), home: toClock(h), clocks: o.zones.filter((z) => z !== h).map(toClock), compact: !!o.compact };
    }
  } catch {}
  return defaults();
}
let S = load();
for (const c of [S.home, ...S.clocks]) {
  if (LEGACY[c.tz]) { if (c.city === cityOf(c.tz)) c.city = cityOf(LEGACY[c.tz]); c.tz = LEGACY[c.tz]; }
}
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch {} };

// ---------- helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const win = inTauri
  ? getCurrentWindow()
  : ({ setSize: async () => {}, hide: async () => {}, setAlwaysOnTop: async () => {} } as unknown as ReturnType<typeof getCurrentWindow>);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

type Parts = { hour: number; minute: number; hh: string; mm: string; weekday: string; key: string };
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(d: Date, tz: string): Parts {
  let f = fmtCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      f = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" });
    }
    fmtCache.set(tz, f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return { hour: +o.hour, minute: +o.minute, hh: o.hour, mm: o.minute, weekday: o.weekday, key: o.year + o.month + o.day };
}
const timeText = (p: Parts) => S.hour12 ? `${((p.hour + 11) % 12) + 1}:${p.mm}${p.hour < 12 ? "am" : "pm"}` : `${p.hh}:${p.mm}`;
const hourText = (h: number) => S.hour12 ? (h === 0 || h === 24 ? "12am" : h === 12 ? "12pm" : h < 12 ? `${h}am` : `${h - 12}pm`) : `${String(h).padStart(2, "0")}:00`;
const inHours = (h: number, c: Clock) => c.start <= c.end ? h >= c.start && h < c.end : h >= c.start || h < c.end; // supports night shifts
const stretch = (h: number, c: Clock) => !inHours(h, c) && (inHours((h + 1) % 24, c) || inHours((h + 23) % 24, c) || inHours((h + 22) % 24, c));
const all = () => [S.home, ...S.clocks];

let offsetSteps = 0; // 15-minute steps from now
const shownTime = () => new Date(Date.now() + offsetSteps * 15 * 60000);

// ---------- clock view ----------
function render() {
  const now = shownTime();
  const home = parts(now, S.home.tz);
  const homeMidnight = now.getTime() - (home.hour * 60 + home.minute) * 60000 - now.getSeconds() * 1000;
  const nowPct = ((home.hour * 60 + home.minute) / 1440) * 100;

  let rows = "", mini = "";
  all().forEach((c, i) => {
    const p = parts(now, c.tz);
    const day = p.key > home.key ? "+1 day" : p.key < home.key ? "−1 day" : p.weekday;
    let cells = "";
    for (let h = 0; h < 24; h++) {
      const lh = parts(new Date(homeMidnight + h * 3600000 + 1800000), c.tz).hour;
      cells += `<span class="${inHours(lh, c) ? "w" : stretch(lh, c) ? "e" : ""}"></span>`;
    }
    const off = !inHours(p.hour, c);
    const dayDelta = p.key > home.key ? 1 : p.key < home.key ? -1 : 0;
    const diff = dayDelta * 1440 + p.hour * 60 + p.minute - (home.hour * 60 + home.minute);
    const diffText = i === 0 ? "" : diff === 0 ? "same time" : `${diff < 0 ? "−" : "+"}${Math.floor(Math.abs(diff) / 60)}h${Math.abs(diff) % 60 ? ` ${Math.abs(diff) % 60}m` : ""}`;
    const sub = [c.label, diffText].filter(Boolean).join(" · ") || c.tz;
    rows += `<div class="row">
      <div><div class="name">${esc(c.city)}${i === 0 ? '<span class="chip">Home</span>' : ""}</div>
        <div class="label">${esc(sub)}</div></div>
      <div><div class="time${off ? " off" : ""}">${timeText(p)}</div><div class="day">${day}</div></div>
      <div class="band" title="${hourText(c.start)}–${hourText(c.end)} local, shown on your day">${cells}<div class="now" style="left:${nowPct.toFixed(2)}%"></div></div>
    </div>`;
    mini += `<span><span class="abbr">${esc(c.city.slice(0, 3).toUpperCase())}</span><b class="${off ? "off" : ""}">${timeText(p)}</b></span>`;
  });
  if (!S.clocks.length) rows += `<div class="empty">Add clocks in settings (⚙) to compare against ${esc(S.home.city)}.</div>`;
  $("rows").innerHTML = rows;
  $("mini").innerHTML = mini;

  const m = offsetSteps * 15, a = Math.abs(m);
  $("offset").textContent = (m < 0 ? "−" : "+") + Math.floor(a / 60) + "h" + (a % 60 ? ` ${a % 60}m` : "");
  $("mode").textContent = offsetSteps === 0 ? "Live" : "Planning";
  $("axis-note").textContent = `Bands = ${S.home.city}'s day`;
}

async function fit() {
  await new Promise((r) => requestAnimationFrame(r));
  const el = S.compact ? $("mini") : $("card");
  const r = el.getBoundingClientRect();
  await win.setSize(new LogicalSize(Math.ceil(S.compact ? r.width : 520), Math.ceil(r.height)));
}

function applyLook() {
  const root = document.documentElement;
  if (S.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", S.theme);
  root.style.setProperty("--opacity", `${S.opacity}%`);
}

function showView(v: "clock" | "settings" | "compact") {
  $("card").hidden = v === "compact";
  $("mini").hidden = v !== "compact";
  $("view-clock").hidden = v !== "clock";
  $("view-settings").hidden = v !== "settings";
  if (v === "settings") renderSettings();
  render();
  fit();
}

// ---------- settings view ----------
const hourOptions = (sel: number) => Array.from({ length: 25 }, (_, h) => `<option value="${h}"${h === sel ? " selected" : ""}>${hourText(h)}</option>`).join("");

function renderSettings() {
  $("home-current").textContent = `Current: ${S.home.tz}. Search to change it.`;
  $<HTMLInputElement>("home-city").value = S.home.city;
  $<HTMLInputElement>("home-search").value = "";
  $("home-results").innerHTML = "";
  $("home-start").innerHTML = hourOptions(S.home.start);
  $("home-end").innerHTML = hourOptions(S.home.end);
  $("clock-count").textContent = `(${S.clocks.length})`;
  $("clock-list").innerHTML = S.clocks.map((c, i) => `
    <div class="clock-edit" data-id="${c.id}">
      <input data-f="city" value="${esc(c.city)}" maxlength="32" aria-label="City name" />
      <input data-f="label" value="${esc(c.label)}" placeholder="Label (client, team…)" maxlength="32" aria-label="Label" />
      <span class="hours"><select data-f="start" aria-label="Work starts">${hourOptions(c.start)}</select>–<select data-f="end" aria-label="Work ends">${hourOptions(c.end)}</select></span>
      <span class="tools">
        <button class="icon" data-act="up" aria-label="Move up"${i === 0 ? " disabled" : ""}>↑</button>
        <button class="icon" data-act="down" aria-label="Move down"${i === S.clocks.length - 1 ? " disabled" : ""}>↓</button>
        <button class="icon" data-act="del" aria-label="Remove">×</button>
      </span>
      <div class="tz">${esc(c.tz)} · now ${timeText(parts(new Date(), c.tz))}</div>
    </div>`).join("") || `<div class="hint">No clocks yet. Search below to add one.</div>`;
  $<HTMLSelectElement>("opt-format").value = S.hour12 ? "12" : "24";
  $<HTMLSelectElement>("opt-theme").value = S.theme;
  $<HTMLInputElement>("opt-opacity").value = String(S.opacity);
  $("opt-opacity-val").textContent = `${S.opacity}%`;
  $("opt-dstart").innerHTML = hourOptions(S.defaultStart);
  $("opt-dend").innerHTML = hourOptions(S.defaultEnd);
  $<HTMLInputElement>("opt-top").checked = S.alwaysOnTop;
  if (inTauri) autoIsOn().then((on) => ($<HTMLInputElement>("opt-autostart").checked = on)).catch(() => {});
}

const commit = (rerenderSettings = false) => { save(); render(); if (rerenderSettings) renderSettings(); fit(); };

// Time-zone search, shared by "home" and "add clock".
const ALL_TZ: string[] = (Intl as any).supportedValuesOf?.("timeZone") ?? [];
function tzSearch(inputId: string, listId: string, onPick: (tz: string) => void) {
  const input = $<HTMLInputElement>(inputId), list = $(listId);
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase().replace(/\s+/g, "_");
    const hits = q.length < 2 ? [] : ALL_TZ.filter((tz) => tz.toLowerCase().includes(q)).slice(0, 8);
    const now = new Date();
    list.innerHTML = hits.map((tz) => `<li data-tz="${tz}">${esc(cityOf(tz))} <small>${tz} · ${timeText(parts(now, tz))}</small></li>`).join("");
    fit();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const first = list.querySelector<HTMLElement>("li"); if (first) onPick(first.dataset.tz!); }
    if (e.key === "Escape") { input.value = ""; list.innerHTML = ""; fit(); }
  });
  list.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("li");
    if (li) onPick(li.dataset.tz!);
  });
}
tzSearch("home-search", "home-results", (tz) => {
  S.home = { ...S.home, tz, city: cityOf(tz) };
  S.clocks = S.clocks.filter((c) => c.tz !== tz);
  commit(true);
});
tzSearch("add-search", "add-results", (tz) => {
  S.clocks.push(mkClock(tz, "", S.defaultStart, S.defaultEnd));
  $<HTMLInputElement>("add-search").value = "";
  $("add-results").innerHTML = "";
  commit(true);
  const list = $("clock-list");
  list.scrollTop = list.scrollHeight;
});

$("home-city").addEventListener("change", (e) => { S.home.city = (e.target as HTMLInputElement).value.trim() || cityOf(S.home.tz); commit(); });
$("home-start").addEventListener("change", (e) => { S.home.start = +(e.target as HTMLSelectElement).value; commit(); });
$("home-end").addEventListener("change", (e) => { S.home.end = +(e.target as HTMLSelectElement).value; commit(); });

$("clock-list").addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement | HTMLSelectElement;
  const row = t.closest<HTMLElement>("[data-id]");
  const c = S.clocks.find((x) => x.id === row?.dataset.id);
  if (!c || !t.dataset.f) return;
  const f = t.dataset.f as keyof Clock;
  if (f === "start" || f === "end") c[f] = +t.value;
  else if (f === "city") c.city = t.value.trim() || cityOf(c.tz);
  else if (f === "label") c.label = t.value.trim();
  commit();
});
$("clock-list").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-act]");
  if (!b) return;
  const i = S.clocks.findIndex((x) => x.id === b.closest<HTMLElement>("[data-id]")?.dataset.id);
  if (i < 0) return;
  const act = b.dataset.act;
  if (act === "del") S.clocks.splice(i, 1);
  if (act === "up" && i > 0) [S.clocks[i - 1], S.clocks[i]] = [S.clocks[i], S.clocks[i - 1]];
  if (act === "down" && i < S.clocks.length - 1) [S.clocks[i + 1], S.clocks[i]] = [S.clocks[i], S.clocks[i + 1]];
  commit(true);
});

$("opt-format").addEventListener("change", (e) => { S.hour12 = (e.target as HTMLSelectElement).value === "12"; commit(true); });
$("opt-theme").addEventListener("change", (e) => { S.theme = (e.target as HTMLSelectElement).value as Theme; applyLook(); save(); });
$("opt-opacity").addEventListener("input", (e) => {
  S.opacity = +(e.target as HTMLInputElement).value;
  $("opt-opacity-val").textContent = `${S.opacity}%`;
  applyLook(); save();
});
$("opt-dstart").addEventListener("change", (e) => { S.defaultStart = +(e.target as HTMLSelectElement).value; save(); });
$("opt-dend").addEventListener("change", (e) => { S.defaultEnd = +(e.target as HTMLSelectElement).value; save(); });
$("opt-top").addEventListener("change", (e) => {
  S.alwaysOnTop = (e.target as HTMLInputElement).checked;
  win.setAlwaysOnTop(S.alwaysOnTop); save();
});
$("opt-autostart").addEventListener("change", async (e) => {
  const box = e.target as HTMLInputElement;
  if (!inTauri) return;
  try { box.checked ? await autoOn() : await autoOff(); } catch { box.checked = !box.checked; }
});

// ---------- clock view events ----------
$<HTMLInputElement>("scrub").addEventListener("input", (e) => { offsetSteps = +(e.target as HTMLInputElement).value; render(); });
$("btn-now").addEventListener("click", () => { offsetSteps = 0; $<HTMLInputElement>("scrub").value = "0"; render(); });
$("btn-copy").addEventListener("click", async () => {
  const now = shownTime();
  const text = all().map((c) => { const p = parts(now, c.tz); return `${timeText(p)} ${c.city} (${p.weekday})`; }).join(" / ");
  try { await navigator.clipboard.writeText(text); flash("Copied"); } catch { flash("Couldn't copy"); }
});
$("btn-settings").addEventListener("click", () => showView("settings"));
$("btn-done").addEventListener("click", () => showView("clock"));
$("btn-compact").addEventListener("click", () => { S.compact = true; save(); showView("compact"); });
$("mini").addEventListener("dblclick", () => { S.compact = false; save(); showView("clock"); });
$("btn-hide").addEventListener("click", () => win.hide());

let toastTimer = 0;
function flash(msg: string) {
  $("toast").textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ($("toast").textContent = ""), 1800);
}

// Tray menu → "Settings…"
if (inTauri) {
  listen("open-settings", () => { S.compact = false; save(); showView("settings"); });
}

// ---------- start ----------
applyLook();
win.setAlwaysOnTop(S.alwaysOnTop);
showView(S.compact ? "compact" : "clock");
setInterval(() => { if (offsetSteps === 0) render(); }, 10000);
