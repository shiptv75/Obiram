// ============================================================
// OBIRAM TV — app.js (Updated with Fully Proxied HLS)
// ============================================================

const VERCEL_PROXY = "https://shiptv.vercel.app/api/proxy?url=";

const M3U_URL = "https://raw.githubusercontent.com/shiptv75/SHIPTV/main/playlist.m3u";
const M3U_URL_2 = "https://raw.githubusercontent.com/ahan443/FAST-IPTV/refs/heads/main/z.m3u";
const M3U_SOURCES = [M3U_URL, M3U_URL_2];

const CORS_PROXIES = [
  (u) => u,
  (u) => `${VERCEL_PROXY}${encodeURIComponent(u)}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
];

const LS_FAV = "obiram_favorites";
const LS_RESUME = "obiram_resume";

let CHANNELS = [];
let GROUPS = [];
let currentChip = "all";
let currentChannel = null;
let activeHlsEngineInstance = null;
let activeMpegtsInstance = null;
let currentStreamUrl = null;
let cvCurrentEngine = "auto";
let activeChannelIndex = -1;
let currentServerList = [];
let currentServerIndex = 0;
let cvIsSeeking = false;
let cvControlsTimer = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function toast(msg, ms = 2200) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), ms);
}

function slugify(str) {
  return (str || "chan")
    .toLowerCase()
    .replace(/[^a-z0-9\u0980-\u09FF]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function loadJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v || fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const raw = [];
  let pending = null;

  for (let ln of lines) {
    const line = ln.trim();
    if (!line || line.startsWith("#EXTM3U")) continue;

    if (line.startsWith("#EXTINF")) {
      if (pending && pending.sources.length) raw.push(pending);

      const nameMatch = line.match(/,(.*)$/);
      const name = (nameMatch ? nameMatch[1].trim() : "Unknown").normalize("NFKC");
      const logoMatch = line.match(/tvg-logo="([^"]*)"/);
      const groupMatch = line.match(/group-title="([^"]*)"/);

      pending = {
        name: name || "Unknown",
        logo: logoMatch ? logoMatch[1] : "",
        group: (groupMatch && groupMatch[1] ? groupMatch[1] : "অন্যান্য").normalize("NFKC"),
        sources: [],
      };
    } else if (line.startsWith("#")) {
      continue;
    } else if (/^https?:\/\//i.test(line)) {
      if (!pending) pending = { name: "Unknown", logo: "", group: "অন্যান্য", sources: [] };
      pending.sources.push(line);
    }
  }
  if (pending && pending.sources.length) raw.push(pending);

  const merged = new Map();
  const order = [];
  raw.forEach((entry) => {
    const key = slugify(entry.name) + "|" + slugify(entry.group);
    if (!merged.has(key)) {
      merged.set(key, { id: key, name: entry.name.trim(), logo: entry.logo, group: entry.group, sources: [] });
      order.push(key);
    }
    const chan = merged.get(key);
    if (!chan.logo && entry.logo) chan.logo = entry.logo;
    entry.sources.forEach((s) => { if (!chan.sources.includes(s)) chan.sources.push(s); });
  });

  return order.map((k) => merged.get(k));
}

async function fetchOnePlaylist(url) {
  for (const wrap of CORS_PROXIES) {
    try {
      const res = await fetch(wrap(url), { cache: "no-store" });
      if (!res.ok) throw new Error("bad status " + res.status);
      const text = await res.text();
      if (text && (text.includes("#EXTM3U") || text.includes("#EXTINF"))) return text;
    } catch (e) {
      continue;
    }
  }
  return null;
}

async function fetchPlaylist() {
  const results = await Promise.all(M3U_SOURCES.map(fetchOnePlaylist));
  const texts = results.filter(Boolean);
  if (!texts.length) throw new Error("প্লেলিস্ট লোড করা যায়নি");
  return texts.join("\n");
}

function setSplashProgress(pct, msg) {
  const fill = $("#splashFill");
  if (fill) fill.style.width = pct + "%";
  if (msg) {
    const sub = $(".splash-sub");
    if (sub) sub.textContent = msg;
  }
}
function hideSplash() {
  const splash = $("#splash");
  if (!splash) return;
  splash.style.opacity = "0";
  splash.style.transition = "opacity .4s ease";
  setTimeout(() => {
    splash.classList.add("hidden");
    $("#app")?.classList.remove("hidden");
  }, 400);
}

const LS_PIN = "obiram_pinned";

const CATEGORY_DEFS = [
  { key: "sports", label: "🏏 Sports", match: /sport|fifa|cricket/i },
  { key: "news", label: "📰 News", match: /news/i },
  { key: "bangla", label: "🇧🇩 Bangla", match: /^bangla$|bangladeshi/i },
  { key: "indian_bangla", label: "🇮🇳 Indian Bangla", match: /indian.?bangla|kolkata/i },
  { key: "movies", label: "🍿 Movies", match: /movie/i },
  { key: "kids", label: "🧸 Kids", match: /kids/i },
  { key: "entertainment", label: "🎭 Entertainment", match: /entertainment|music/i },
  { key: "lifestyle", label: "📖 Lifestyle", match: /document|lifestyle/i },
  { key: "religious", label: "🛐 Religious", match: /islamic|religious/i },
];

function categorize(chan) {
  for (const def of CATEGORY_DEFS) {
    if (def.match.test(chan.group)) return def.key;
  }
  return "other";
}

function buildGroups() {
  CHANNELS.forEach((c) => { c.category = categorize(c); });
}

function chipCounts() {
  const counts = { all: CHANNELS.length, favs: loadJSON(LS_FAV, []).length, pinned: loadJSON(LS_PIN, []).length, other: 0 };
  CATEGORY_DEFS.forEach((d) => (counts[d.key] = 0));
  CHANNELS.forEach((c) => { counts[c.category] = (counts[c.category] || 0) + 1; });
  return counts;
}

function renderChipBar() {
  const bar = $("#chipBar");
  if (!bar) return;
  const counts = chipCounts();
  const chips = [
    { key: "all", label: "🌐 All" },
    { key: "favs", label: "❤️ Favs" },
    { key: "pinned", label: "📌 Pinned" },
    ...CATEGORY_DEFS,
    { key: "other", label: "📂 Other" },
  ];
  bar.innerHTML = chips
    .map(
      (c) =>
        `<button class="chip${c.key === currentChip ? " active" : ""}" data-key="${c.key}">${c.label} <span class="chip-cnt">${counts[c.key] || 0}</span></button>`
    )
    .join("");
  bar.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => setChip(btn.dataset.key));
  });
}

function setChip(key) {
  currentChip = key;
  $$(".chip").forEach((c) => c.classList.toggle("active", c.dataset.key === key));
  const input = $("#searchInput");
  if (input) input.value = "";
  $("#searchClear")?.classList.add("hidden");
  applyFilters();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function channelCard(chan) {
  const card = document.createElement("div");
  card.className = "chan-card";
  card.dataset.id = chan.id;

  const favs = loadJSON(LS_FAV, []);
  const pins = loadJSON(LS_PIN, []);
  const isFav = favs.includes(chan.id);
  const isPinned = pins.includes(chan.id);

  card.innerHTML = `
    <button class="chan-pin ${isPinned ? "on" : ""}" aria-label="পিন" data-id="${chan.id}">📌</button>
    <button class="chan-fav ${isFav ? "on" : ""}" aria-label="প্রিয়" data-id="${chan.id}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.6-10.2-9.2C.3 8.7 1.8 5 5.4 4.3c2-.4 3.9.5 5 2.2l1.6 2.4 1.6-2.4c1.1-1.7 3-2.6 5-2.2 3.6.7 5.1 4.4 3.6 7.5C19.5 16.4 12 21 12 21z"/></svg>
    </button>
    <div class="chan-logo-wrap">
      ${
        chan.logo
          ? `<img src="${chan.logo}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<div class=&quot;chan-logo-fallback&quot;>${chan.name.slice(0, 2).toUpperCase()}</div>'">`
          : `<div class="chan-logo-fallback">${chan.name.slice(0, 2).toUpperCase()}</div>`
      }
    </div>
    <div class="chan-name">${chan.name}</div>
  `;

  card.addEventListener("click", (e) => {
    if (e.target.closest(".chan-fav") || e.target.closest(".chan-pin")) return;
    openPlayer(chan);
  });

  card.querySelector(".chan-fav")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFav(chan.id);
    e.currentTarget.classList.toggle("on");
    renderChipBar();
    if (currentChip === "favs") applyFilters();
  });

  card.querySelector(".chan-pin")?.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePin(chan.id);
    e.currentTarget.classList.toggle("on");
    renderChipBar();
    if (currentChip === "pinned") applyFilters();
  });

  return card;
}

function renderGrid(list) {
  const grid = $("#mainGrid");
  if (!grid) return;
  grid.innerHTML = "";
  $("#emptyState")?.classList.toggle("hidden", list.length > 0);
  list.forEach((c) => grid.appendChild(channelCard(c)));
}

function applyFilters() {
  const input = $("#searchInput");
  const q = input ? input.value.trim().toLowerCase() : "";
  let list;
  if (currentChip === "all") list = CHANNELS;
  else if (currentChip === "favs") {
    const favs = loadJSON(LS_FAV, []);
    list = favs.map((id) => CHANNELS.find((c) => c.id === id)).filter(Boolean);
  } else if (currentChip === "pinned") {
    const pins = loadJSON(LS_PIN, []);
    list = pins.map((id) => CHANNELS.find((c) => c.id === id)).filter(Boolean);
  } else {
    list = CHANNELS.filter((c) => c.category === currentChip);
  }

  if (q) list = list.filter((c) => c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));

  const emptyText = $("#emptyStateText");
  if (emptyText) {
    if (currentChip === "favs") emptyText.textContent = "এখনো কোনো প্রিয় চ্যানেল নেই — হার্ট আইকনে ক্লিক করে যোগ করো";
    else if (currentChip === "pinned") emptyText.textContent = "এখনো কোনো পিন করা চ্যানেল নেই — 📌 আইকনে ক্লিক করে যোগ করো";
    else emptyText.textContent = "কোনো চ্যানেল পাওয়া যায়নি";
  }

  renderGrid(list);
}

function togglePin(id) {
  let pins = loadJSON(LS_PIN, []);
  if (pins.includes(id)) pins = pins.filter((f) => f !== id);
  else pins.push(id);
  saveJSON(LS_PIN, pins);
}

function toggleFav(id) {
  let favs = loadJSON(LS_FAV, []);
  if (favs.includes(id)) favs = favs.filter((f) => f !== id);
  else favs.push(id);
  saveJSON(LS_FAV, favs);
}

function renderResumeRow() {
  const resume = loadJSON(LS_RESUME, null);
  const section = $("#resumeSection");
  if (!section) return;
  if (!resume) { section.classList.add("hidden"); return; }
  const chan = CHANNELS.find((c) => c.id === resume.id);
  if (!chan) { section.classList.add("hidden"); return; }
  section.classList.remove("hidden");
  const row = $("#resumeRow");
  if (!row) return;
  row.innerHTML = "";
  const card = document.createElement("div");
  card.className = "resume-card";
  card.innerHTML = `
    <img src="${chan.logo || ""}" alt="" onerror="this.style.display='none'">
    <div class="rc-name">${chan.name}</div>
    <div class="rc-grp">${chan.group}</div>
  `;
  card.addEventListener("click", () => openPlayer(chan));
  row.appendChild(card);
}

function saveResume(chan) {
  saveJSON(LS_RESUME, { id: chan.id, t: Date.now() });
}

function setupSearch() {
  const input = $("#searchInput");
  const clearBtn = $("#searchClear");
  if (!input) return;
  input.addEventListener("input", () => {
    clearBtn?.classList.toggle("hidden", !input.value.trim());
    applyFilters();
  });
  clearBtn?.addEventListener("click", () => {
    input.value = "";
    clearBtn.classList.add("hidden");
    applyFilters();
    input.focus();
  });
}

function setupHelpDrawer() {
  const fab = $("#helpFab");
  const overlay = $("#helpOverlay");
  const closeBtn = $("#helpClose");
  if (!fab || !overlay) return;
  fab.addEventListener("click", () => overlay.classList.remove("hidden"));
  closeBtn?.addEventListener("click", () => overlay.classList.add("hidden"));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.add("hidden"); });
}

function tickClock() {
  const el = $("#liveClock");
  if (!el) return;
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  el.textContent = `${h}:${m}`;
}

// ================= PLAYER =================

function openPlayer(chan) {
  currentChannel = chan;
  activeChannelIndex = CHANNELS.findIndex((c) => c.id === chan.id);
  saveResume(chan);
  renderResumeRow();

  cvInitVideoEvents();
  playChannel(chan);

  if (window.innerWidth <= 860) {
    $("#playerPane")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function playChannel(ch) {
  currentChannel = ch;
  activeChannelIndex = CHANNELS.findIndex((c) => c.id === ch.id);

  const titleEl = $("#player-channel-title");
  if (titleEl) titleEl.textContent = ch.name;
  const statusEl = $("#player-channel-status");
  if (statusEl) statusEl.innerHTML = `▶ You're watching <strong>${ch.name}</strong> live on Obiram TV`;
  const logoFrame = $("#player-logo-frame");
  if (logoFrame) {
    logoFrame.innerHTML = ch.logo
      ? `<img src="${ch.logo}" style="max-width:100%;max-height:100%;object-fit:contain;" onerror="this.style.display='none'">`
      : `<i class="fa-solid fa-play" style="font-size:20px;color:var(--cv-primary);"></i>`;
  }

  cvBuildServerListFromChannel(ch);
  cvLoadStreamSource(ch.sources[0]);
}

function cvBuildServerListFromChannel(ch) {
  currentServerList = ch.sources.map((url, i) => ({ name: `Server ${i + 1}`, url }));
  currentServerIndex = 0;
  renderServerMenu();
}

function renderServerMenu() {
  const list = $("#cv-server-list");
  if (!list) return;
  list.innerHTML = "";
  if (currentServerList.length <= 1) {
    list.innerHTML = `<div style="padding:10px;font-size:11.5px;color:rgba(255,255,255,0.55);text-align:center;">Only 1 source available</div>`;
    return;
  }
  currentServerList.forEach((s, idx) => {
    const item = document.createElement("div");
    item.className = "cv-server-item" + (idx === currentServerIndex ? " active" : "");
    item.innerHTML = `<span class="cv-server-dot"></span>Server ${idx + 1}`;
    item.onclick = (e) => { e.stopPropagation(); cvSwitchServer(idx); };
    list.appendChild(item);
  });
}

function cvSwitchServer(idx) {
  if (!currentServerList[idx]) return;
  currentServerIndex = idx;
  renderServerMenu();
  cvShowToast(`🔁 Server ${idx + 1}`);
  cvLoadStreamSource(currentServerList[idx].url);
  closeServerMenu();
}

function closeServerMenu() { $("#cv-server-dropdown")?.classList.remove("open"); }

function destroyExistingPlayers() {
  const video = $("#main-hybrid-video-node");
  if (activeHlsEngineInstance) { try { activeHlsEngineInstance.destroy(); } catch {} activeHlsEngineInstance = null; }
  if (activeMpegtsInstance) { try { activeMpegtsInstance.destroy(); } catch {} activeMpegtsInstance = null; }
  if (video) { video.removeAttribute("src"); video.load(); }
}

// ── Vercel প্রক্সি দিয়ে ভিডিও প্লেব্যাক ──
function cvLoadStreamSource(rawUrl) {
  const video = $("#main-hybrid-video-node");
  if (!rawUrl || !video) return;

  const savedVolume = video.volume || 1;
  const savedMuted = video.muted || false;

  currentStreamUrl = rawUrl;
  destroyExistingPlayers();
  cvShowLoader(true);
  cvInitVideoEvents();

  let targetUrl = rawUrl.trim();
  if (!targetUrl.startsWith(VERCEL_PROXY)) {
    targetUrl = `${VERCEL_PROXY}${encodeURIComponent(targetUrl)}`;
  }

  function restoreVolume() {
    video.volume = savedVolume;
    video.muted = savedMuted;
  }

  if (window.Hls && Hls.isSupported()) {
    activeHlsEngineInstance = new Hls({
      maxBufferLength: 10,
      maxMaxBufferLength: 30,
      enableWorker: true,
      lowLatencyMode: true,
      // সেগমেন্টগুলোকেও প্রক্সি দিয়ে লোড করার কাস্টম লজিক
      pLoader: function(config) {
        const loader = new Hls.DefaultConfig.loader(config);
        this.load = function(context, config, callbacks) {
          if (context.url && !context.url.startsWith(VERCEL_PROXY)) {
            context.url = `${VERCEL_PROXY}${encodeURIComponent(context.url)}`;
          }
          loader.load(context, config, callbacks);
        };
        this.abort = function() { loader.abort(); };
        this.destroy = function() { loader.destroy(); };
      }
    });

    activeHlsEngineInstance.loadSource(targetUrl);
    activeHlsEngineInstance.attachMedia(video);

    activeHlsEngineInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      restoreVolume();
      video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
    });

    activeHlsEngineInstance.on(Hls.Events.ERROR, (evt, data) => {
      if (!data.fatal) return;
      cvShowLoader(false);
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        activeHlsEngineInstance.startLoad();
      } else {
        video.src = targetUrl;
        video.play().catch(() => {});
      }
    });
  } else {
    video.src = targetUrl;
    restoreVolume();
    video.play().catch(() => {});
  }
}

function cvShowToast(msg) {
  const t = $("#cv-toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(cvShowToast._t);
  cvShowToast._t = setTimeout(() => t.classList.remove("show"), 1200);
}

function cvShowLoader(show) {
  const l = $("#cv-loader");
  if (l) l.className = show ? "cv-loading-ring active" : "cv-loading-ring";
}

function cvInitVideoEvents() {
  const v = $("#main-hybrid-video-node");
  if (!v) return;
  v.onplay = () => cvShowLoader(false);
  v.onwaiting = () => cvShowLoader(true);
  v.oncanplay = () => cvShowLoader(false);
  v.onerror = () => cvShowLoader(false);
}

async function init() {
  setupSearch();
  setupHelpDrawer();
  tickClock();

  setSplashProgress(30, "প্লেলিস্ট লোড হচ্ছে...");
  try {
    const text = await fetchPlaylist();
    setSplashProgress(70, "চ্যানেল সাজানো হচ্ছে...");
    CHANNELS = parseM3U(text);

    buildGroups();
    renderChipBar();
    applyFilters();
    renderResumeRow();

    setSplashProgress(100, "রেডি!");
    setTimeout(hideSplash, 300);
  } catch (e) {
    setSplashProgress(100, "ত্রুটি হয়েছে!");
    setTimeout(() => location.reload(), 3000);
  }
}

document.addEventListener("DOMContentLoaded", init);
