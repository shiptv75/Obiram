// ============================================================
// OBIRAM TV — app.js
// ============================================================

const M3U_URL = "https://raw.githubusercontent.com/shiptv75/SHIPTV/main/playlist.m3u";
const M3U_URL_2 = "https://raw.githubusercontent.com/ahan443/FAST-IPTV/refs/heads/main/z.m3u";
const M3U_SOURCES = [M3U_URL, M3U_URL_2];
const CORS_PROXIES = [
  (u) => u, // try direct first
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
];

const LS_FAV = "obiram_favorites";
const LS_RESUME = "obiram_resume";

let CHANNELS = [];      // flat list {id,name,group,logo,sources[]}
let GROUPS = [];        // ordered unique group names
let currentView = "home"; // 'home' | 'movies' | 'sportz'
let currentChannel = null;
let hls = null;
let mpegtsPlayer = null;
let currentSourceIndex = 0;
let retryTimer = null;

// ---- Player engine state (ported from Shamim IPTV Blogger theme) ----
let activeHlsEngineInstance = null;
let activeMpegtsInstance = null;
let currentStreamUrl = null;
let cvCurrentEngine = "auto"; // 'auto' | 'hls' | 'mpegts' | 'native'
let activeChannelIndex = -1;
let currentServerList = [];
let currentServerIndex = 0;
let cvIsSeeking = false;
let cvControlsTimer = null;

// ---------- Utility ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function toast(msg, ms = 2200) {
  const el = $("#toast");
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

// ---------- M3U Parsing ----------
// Handles two real-world patterns from live-updating playlists:
//  1) one #EXTINF followed by several stacked URL lines (fallback servers)
//  2) the same channel repeated as separate #EXTINF blocks, each with one URL
// Both are merged into a single channel with a combined, de-duplicated
// sources[] list so the player's server-fallback UI works either way.
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

  // merge duplicate channel entries (same name+group) into one, combining sources
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

// ---------- Fetch playlist with proxy fallback ----------
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
  return null; // this source failed, but others may still succeed
}

async function fetchPlaylist() {
  const results = await Promise.all(M3U_SOURCES.map(fetchOnePlaylist));
  const texts = results.filter(Boolean);
  if (!texts.length) throw new Error("প্লেলিস্ট লোড করা যায়নি");
  return texts.join("\n");
}

// ---------- Splash ----------
function setSplashProgress(pct, msg) {
  $("#splashFill").style.width = pct + "%";
  if (msg) $(".splash-sub").textContent = msg;
}
function hideSplash() {
  const splash = $("#splash");
  splash.style.opacity = "0";
  splash.style.transition = "opacity .4s ease";
  setTimeout(() => {
    splash.classList.add("hidden");
    $("#app").classList.remove("hidden");
  }, 400);
}

// ---------- Render sidebar / categories ----------
function buildGroups() {
  const map = {};
  CHANNELS.forEach((c) => { map[c.group] = (map[c.group] || 0) + 1; });
  GROUPS = Object.keys(map).sort((a, b) => map[b] - map[a]);
  return map;
}

function renderSidebar(counts) {
  const list = $("#catList");
  list.innerHTML = "";

  const allItem = document.createElement("div");
  allItem.className = "cat-item active";
  allItem.dataset.group = "__all__";
  allItem.innerHTML = `<span>সব চ্যানেল</span><span class="cnt">${CHANNELS.length}</span>`;
  list.appendChild(allItem);

  GROUPS.forEach((g) => {
    const item = document.createElement("div");
    item.className = "cat-item";
    item.dataset.group = g;
    item.innerHTML = `<span>${g}</span><span class="cnt">${counts[g]}</span>`;
    list.appendChild(item);
  });

  list.addEventListener("click", (e) => {
    const item = e.target.closest(".cat-item");
    if (!item) return;
    $$(".cat-item").forEach((i) => i.classList.remove("active"));
    item.classList.add("active");
    const g = item.dataset.group;
    if (currentView !== "home") switchView("home");
    if (g === "__all__") {
      renderCatSections(CHANNELS);
    } else {
      setTimeout(() => {
        document.getElementById("sec-" + slugify(g))?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    }
    closeSidebarMobile();
  });
}

// ---------- Channel card ----------
function channelCard(chan) {
  const card = document.createElement("div");
  card.className = "chan-card";
  card.dataset.id = chan.id;

  const favs = loadJSON(LS_FAV, []);
  const isFav = favs.includes(chan.id);

  card.innerHTML = `
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
    if (e.target.closest(".chan-fav")) return;
    openPlayer(chan);
  });

  card.querySelector(".chan-fav").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFav(chan.id);
    e.currentTarget.classList.toggle("on");
    renderFavRow();
  });

  return card;
}

// ---------- Grid by category ----------
function renderCatSections(list) {
  const wrap = $("#catSections");
  wrap.innerHTML = "";
  $("#emptyState").classList.toggle("hidden", list.length > 0);
  if (!list.length) return;

  const byGroup = {};
  list.forEach((c) => {
    byGroup[c.group] = byGroup[c.group] || [];
    byGroup[c.group].push(c);
  });

  const order = GROUPS.filter((g) => byGroup[g]);
  order.forEach((g) => {
    const section = document.createElement("section");
    section.className = "cat-section";
    section.id = "sec-" + slugify(g);

    const title = document.createElement("div");
    title.className = "cat-section-title";
    title.innerHTML = `<span>${g}</span><span class="cs-count">${byGroup[g].length}টি চ্যানেল</span>`;
    section.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "grid";
    byGroup[g].forEach((c) => grid.appendChild(channelCard(c)));
    section.appendChild(grid);

    wrap.appendChild(section);
  });
}

// ---------- Zones: Movies / Sportz ----------
function moviePoster(chan) {
  const card = document.createElement("div");
  card.className = "poster-card";
  card.innerHTML = `
    <div class="poster-thumb">
      <span class="poster-badge"><span class="live-dot" style="width:5px;height:5px;"></span>LIVE</span>
      ${
        chan.logo
          ? `<img src="${chan.logo}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;poster-fallback&quot;>${chan.name}</div>'">`
          : `<div class="poster-fallback">${chan.name}</div>`
      }
    </div>
    <div class="poster-name">${chan.name}</div>
  `;
  card.addEventListener("click", () => openPlayer(chan));
  return card;
}

function sportCard(chan) {
  const card = document.createElement("div");
  card.className = "sport-card";
  card.innerHTML = `
    <img class="sport-logo" src="${chan.logo || ""}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
    <div class="sport-info">
      <div class="sport-name">${chan.name}</div>
      <div class="sport-live-tag"><span class="live-dot" style="width:6px;height:6px;"></span>LIVE NOW</div>
    </div>
  `;
  card.addEventListener("click", () => openPlayer(chan));
  return card;
}

function renderMoviesZone() {
  const grid = $("#moviesGrid");
  grid.innerHTML = "";
  const movies = CHANNELS.filter((c) => /movie/i.test(c.group));
  movies.forEach((c) => grid.appendChild(moviePoster(c)));
  if (!movies.length) grid.innerHTML = `<p style="color:var(--muted);font-size:13px;">এখনো কোনো মুভি চ্যানেল পাওয়া যায়নি।</p>`;
}

function renderSportzZone() {
  const grid = $("#sportzGrid");
  grid.innerHTML = "";
  const sports = CHANNELS.filter((c) => /sport|fifa|cricket/i.test(c.group));
  sports.forEach((c) => grid.appendChild(sportCard(c)));
  if (!sports.length) grid.innerHTML = `<p style="color:var(--muted);font-size:13px;">এখনো কোনো স্পোর্টস চ্যানেল পাওয়া যায়নি।</p>`;
}

function switchView(view) {
  currentView = view;
  $$(".zone-tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));

  const homeEls = ["#resumeSection", "#favSection", "#catSections"];
  $("#moviesZone").classList.toggle("hidden", view !== "movies");
  $("#sportzZone").classList.toggle("hidden", view !== "sportz");
  $("#emptyState").classList.add("hidden");

  if (view === "home") {
    $("#catSections").classList.remove("hidden");
    renderResumeRow();
    renderFavRow();
    renderCatSections(CHANNELS);
  } else {
    homeEls.forEach((sel) => $(sel).classList.add("hidden"));
    if (view === "movies") renderMoviesZone();
    if (view === "sportz") renderSportzZone();
  }

  $("#searchInput").value = "";
  $("#searchClear").classList.add("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setupZoneNav() {
  $("#zoneNav").addEventListener("click", (e) => {
    const btn = e.target.closest(".zone-tab");
    if (!btn) return;
    switchView(btn.dataset.view);
  });
}

// ---------- Favorites row ----------
function renderFavRow() {
  const favIds = loadJSON(LS_FAV, []);
  const favSection = $("#favSection");
  const row = $("#favRow");
  row.innerHTML = "";
  const favChans = favIds.map((id) => CHANNELS.find((c) => c.id === id)).filter(Boolean);
  favSection.classList.toggle("hidden", favChans.length === 0);
  favChans.forEach((chan) => {
    const card = document.createElement("div");
    card.className = "resume-card";
    card.innerHTML = `
      <img src="${chan.logo || ""}" alt="" onerror="this.style.display='none'">
      <div class="rc-name">${chan.name}</div>
      <div class="rc-grp">${chan.group}</div>
    `;
    card.addEventListener("click", () => openPlayer(chan));
    row.appendChild(card);
  });
}

function toggleFav(id) {
  let favs = loadJSON(LS_FAV, []);
  if (favs.includes(id)) favs = favs.filter((f) => f !== id);
  else favs.push(id);
  saveJSON(LS_FAV, favs);
}

// ---------- Resume row ----------
function renderResumeRow() {
  const resume = loadJSON(LS_RESUME, null);
  const section = $("#resumeSection");
  if (!resume) { section.classList.add("hidden"); return; }
  const chan = CHANNELS.find((c) => c.id === resume.id);
  if (!chan) { section.classList.add("hidden"); return; }
  section.classList.remove("hidden");
  const row = $("#resumeRow");
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

// ---------- Search ----------
function setupSearch() {
  const input = $("#searchInput");
  const clearBtn = $("#searchClear");
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    clearBtn.classList.toggle("hidden", !q);
    if (q && currentView !== "home") {
      currentView = "home";
      $$(".zone-tab").forEach((t) => t.classList.toggle("active", t.dataset.view === "home"));
      $("#moviesZone").classList.add("hidden");
      $("#sportzZone").classList.add("hidden");
      $("#catSections").classList.remove("hidden");
      $("#resumeSection").classList.add("hidden");
      $("#favSection").classList.add("hidden");
    }
    if (!q) { renderCatSections(CHANNELS); return; }
    const filtered = CHANNELS.filter(
      (c) => c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)
    );
    renderCatSections(filtered);
  });
  clearBtn.addEventListener("click", () => {
    input.value = "";
    clearBtn.classList.add("hidden");
    renderCatSections(CHANNELS);
    input.focus();
  });
}

// ---------- Sidebar mobile toggle ----------
function closeSidebarMobile() {
  $("#sidebar").classList.remove("open");
  $("#sidebarOverlay").classList.add("hidden");
}
function setupSidebarToggle() {
  $("#menuToggle").addEventListener("click", () => {
    $("#sidebar").classList.add("open");
    $("#sidebarOverlay").classList.remove("hidden");
  });
  $("#sidebarOverlay").addEventListener("click", closeSidebarMobile);
}

// ---------- Clock ----------
function tickClock() {
  const el = $("#liveClock");
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  el.textContent = `${h}:${m}`;
}

// ================= PLAYER (ported 1:1 from Shamim IPTV Blogger theme) =================

// ---- entry point: open a channel ----
function openPlayer(chan) {
  currentChannel = chan;
  activeChannelIndex = CHANNELS.findIndex((c) => c.id === chan.id);
  saveResume(chan);
  renderResumeRow();

  $("#playerOverlay").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  cvInitVideoEvents();
  playChannel(chan);
}

function closePlayer() {
  destroyExistingPlayers();
  $("#playerOverlay").classList.add("hidden");
  document.body.style.overflow = "";
  cvShowPoster();
  currentChannel = null;
}

// ── same channel selected from grid/float-list/prev-next ──
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

// ── server list is simply the channel's own merged sources[] ──
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

function toggleServerMenu() { $("#cv-server-dropdown")?.classList.toggle("open"); }
function closeServerMenu() { $("#cv-server-dropdown")?.classList.remove("open"); }
document.addEventListener("click", (e) => {
  const dd = $("#cv-server-dropdown");
  const btn = $("#cv-server-btn");
  if (dd && dd.classList.contains("open") && !dd.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
    closeServerMenu();
  }
});

// ── TS vs HLS detection heuristic ──
function isTsStream(url) {
  if (!url) return false;
  if (/\.m3u8(\?.*)?$/i.test(url)) return false;
  if (/\/mono\.m3u8/i.test(url)) return false;
  if (/\.ts(\?.*)?$/i.test(url)) return true;
  if (/\/mono\.ts(\?.*)?$/i.test(url)) return true;
  if (/tracks-v\d+a\d+/.test(url) && url.indexOf(".m3u8") === -1) return true;
  if (/\.stream\/tracks/.test(url) && url.indexOf(".m3u8") === -1) return true;
  if (/jagobd\.com/.test(url) && url.indexOf(".m3u8") === -1) return true;
  if (/bozztv\.com.+tracks/i.test(url) && url.indexOf(".m3u8") === -1) return true;
  if (/giatv-\d+/i.test(url) && url.indexOf(".m3u8") === -1) return true;
  if (/ncare\.live.+\.stream/i.test(url) && url.indexOf(".m3u8") === -1) return true;
  return false;
}

function destroyExistingPlayers() {
  const video = $("#main-hybrid-video-node");
  if (activeHlsEngineInstance) { try { activeHlsEngineInstance.destroy(); } catch {} activeHlsEngineInstance = null; }
  if (activeMpegtsInstance) { try { activeMpegtsInstance.destroy(); } catch {} activeMpegtsInstance = null; }
  if (video) { video.removeAttribute("src"); video.load(); }
}

// ── reusable stream loader (channel switch & server switch both use this) ──
function cvLoadStreamSource(rawUrl) {
  const video = $("#main-hybrid-video-node");
  if (!rawUrl || !video) return;

  const savedVolume = video.volume || 1;
  const savedMuted = video.muted || false;

  currentStreamUrl = rawUrl;
  destroyExistingPlayers();
  cvShowLoader(true);
  cvInitVideoEvents();

  const url = rawUrl.trim();
  const qsel = $("#cv-quality-select");
  if (qsel) { qsel.innerHTML = `<option value="-1">Auto</option>`; qsel.disabled = true; }

  function restoreVolume() {
    video.volume = savedVolume;
    video.muted = savedMuted;
    const slider = $("#cv-vol-slider");
    if (slider) slider.value = savedMuted ? 0 : savedVolume;
    cvUpdateVolIcon(savedVolume, savedMuted);
  }

  function tryNative() {
    destroyExistingPlayers();
    video.src = url;
    restoreVolume();
    video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
  }

  function tryMpegts(onFail) {
    if (typeof mpegts === "undefined" || !mpegts.isSupported()) { if (onFail) onFail(); return; }
    destroyExistingPlayers();
    activeMpegtsInstance = mpegts.createPlayer({
      type: "mpegts", url, isLive: true, enableWorker: true, cors: true, withCredentials: false, liveBufferLatencyChasing: true,
    });
    activeMpegtsInstance.attachMediaElement(video);
    activeMpegtsInstance.load();
    activeMpegtsInstance.on(mpegts.Events.ERROR, () => { cvShowLoader(false); if (onFail) onFail(); else tryNative(); });
    restoreVolume();
    video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
  }

  if (cvCurrentEngine === "mpegts") { tryMpegts(tryNative); return; }
  if (cvCurrentEngine === "native") { tryNative(); return; }
  if (cvCurrentEngine === "auto" && isTsStream(url)) { tryMpegts(tryNative); return; }

  if (window.Hls && Hls.isSupported()) {
    activeHlsEngineInstance = new Hls({
      maxBufferLength: 10, maxMaxBufferLength: 30, maxBufferSize: 30 * 1000 * 1000,
      enableWorker: true, lowLatencyMode: true, startLevel: -1,
      manifestLoadingTimeOut: 10000, manifestLoadingMaxRetry: 2,
      levelLoadingTimeOut: 8000, fragLoadingTimeOut: 10000,
      xhrSetup: (xhr) => { xhr.withCredentials = false; },
    });
    activeHlsEngineInstance.loadSource(url);
    activeHlsEngineInstance.attachMedia(video);

    activeHlsEngineInstance.on(Hls.Events.MANIFEST_PARSED, (evt, data) => {
      restoreVolume();
      video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
      const levels = data.levels;
      if (levels && levels.length > 1 && qsel) {
        qsel.innerHTML = `<option value="-1">Auto</option>`;
        levels.forEach((l, i) => {
          const opt = document.createElement("option");
          opt.value = i;
          opt.textContent = l.height ? l.height + "p" : "Level " + (i + 1);
          qsel.appendChild(opt);
        });
        qsel.disabled = false;
      }
    });
    activeHlsEngineInstance.on(Hls.Events.LEVEL_SWITCHED, (evt, data) => {
      const lvl = activeHlsEngineInstance.levels[data.level];
      const badge = $("#cv-quality-badge");
      if (badge && lvl) badge.textContent = lvl.height ? lvl.height + "p" : "Auto";
    });
    activeHlsEngineInstance.on(Hls.Events.ERROR, (evt, data) => {
      if (!data.fatal) return;
      cvShowLoader(false);
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (currentServerList.length > 1 && currentServerIndex < currentServerList.length - 1) {
          currentServerIndex++;
          cvShowToast(`⚡ Auto: Server ${currentServerIndex + 1}`);
          renderServerMenu();
          cvLoadStreamSource(currentServerList[currentServerIndex].url);
        } else {
          tryMpegts(tryNative);
        }
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        activeHlsEngineInstance.recoverMediaError();
      } else {
        tryNative();
      }
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    restoreVolume();
    video.addEventListener("loadedmetadata", () => video.play().catch(() => { video.muted = true; video.play().catch(() => {}); }), { once: true });
  } else {
    tryNative();
  }
}

// ── toast, play/pause, mute, volume, fullscreen, pip ──
function cvShowToast(msg) {
  const t = $("#cv-toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(cvShowToast._t);
  cvShowToast._t = setTimeout(() => t.classList.remove("show"), 1200);
}

function cvTogglePlay() {
  const v = $("#main-hybrid-video-node");
  if (!v) return;
  if (v.paused) { v.play(); cvShowToast("▶ Play"); } else { v.pause(); cvShowToast("⏸ Pause"); }
}

function cvToggleMute() {
  const v = $("#main-hybrid-video-node");
  const slider = $("#cv-vol-slider");
  if (!v) return;
  v.muted = !v.muted;
  cvUpdateVolIcon(v.volume, v.muted);
  if (slider) slider.value = v.muted ? 0 : v.volume;
  cvShowToast(v.muted ? "🔇 Muted" : "🔊 Unmuted");
}

function cvSetVolume(val) {
  const v = $("#main-hybrid-video-node");
  if (!v) return;
  v.volume = parseFloat(val);
  v.muted = parseFloat(val) === 0;
  cvUpdateVolIcon(parseFloat(val), v.muted);
}

function cvToggleFullscreen() {
  const frame = $("#cv-player-frame");
  const icon = $("#cv-fs-icon");
  if (!frame) return;
  if (!document.fullscreenElement) {
    frame.requestFullscreen?.().catch(() => {});
    if (icon) icon.className = "fa-solid fa-compress";
    cvShowToast("⛶ Fullscreen");
  } else {
    document.exitFullscreen?.();
    if (icon) icon.className = "fa-solid fa-expand";
    cvShowToast("↙ Exit Fullscreen");
  }
}

function cvTogglePip() {
  const v = $("#main-hybrid-video-node");
  if (!v) return;
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
  } else if (document.pictureInPictureEnabled) {
    v.requestPictureInPicture().catch(() => {});
    cvShowToast("⧉ Picture in Picture");
  } else {
    cvShowToast("এই ব্রাউজারে PiP সাপোর্ট নেই");
  }
}

function cvSetQuality(val) {
  if (!activeHlsEngineInstance) return;
  activeHlsEngineInstance.currentLevel = parseInt(val, 10);
  const sel = $("#cv-quality-select");
  cvShowToast("Quality: " + (val === "-1" ? "Auto" : sel.options[sel.selectedIndex].text));
}

function cvToggleEnginePanel() {
  const panel = $("#cv-engine-panel");
  if (!panel) return;
  panel.style.display = panel.style.display === "none" ? "block" : "none";
}

function cvSetEngine(engine) {
  cvCurrentEngine = engine;
  const panel = $("#cv-engine-panel");
  if (panel) panel.style.display = "none";
  $$(".cv-engine-btn").forEach((b) => b.classList.toggle("active", b.dataset.engine === engine));
  const label = $("#cv-engine-label");
  if (label) label.textContent = engine === "auto" ? "Auto" : engine === "hls" ? "HLS.js" : engine === "mpegts" ? "mpegts" : "Native";
  if (currentStreamUrl) cvLoadStreamSource(currentStreamUrl);
  cvShowToast("Engine: " + (label ? label.textContent : engine));
}

// ── next/previous channel (cycles through the full channel list) ──
function cvPlayNext() {
  if (!CHANNELS.length) return;
  const nextIdx = (activeChannelIndex + 1) % CHANNELS.length;
  playChannel(CHANNELS[nextIdx]);
  cvShowToast("⏭ " + CHANNELS[nextIdx].name);
}
function cvPlayPrev() {
  if (!CHANNELS.length) return;
  const prevIdx = (activeChannelIndex - 1 + CHANNELS.length) % CHANNELS.length;
  playChannel(CHANNELS[prevIdx]);
  cvShowToast("⏮ " + CHANNELS[prevIdx].name);
}

// ── seek / progress bar ──
function cvSeekFraction(e) {
  const bar = $("#cv-progress-wrap");
  if (!bar) return 0;
  const rect = bar.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
}
function cvSeekStart(e) {
  const v = $("#main-hybrid-video-node");
  if (!v || !v.duration || !isFinite(v.duration)) return;
  cvIsSeeking = true;
  cvApplySeekFraction(cvSeekFraction(e));
}
function cvSeekPreview(e) { if (cvIsSeeking) cvApplySeekFraction(cvSeekFraction(e)); }
function cvSeekEnd(e) {
  if (!cvIsSeeking) return;
  cvIsSeeking = false;
  const v = $("#main-hybrid-video-node");
  if (!v || !v.duration || !isFinite(v.duration)) return;
  v.currentTime = cvSeekFraction(e) * v.duration;
}
function cvApplySeekFraction(frac) {
  const fill = $("#cv-progress-fill");
  const thumb = $("#cv-progress-thumb");
  if (fill) fill.style.width = frac * 100 + "%";
  if (thumb) thumb.style.left = frac * 100 + "%";
}
function cvFmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return "--:--";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return (h > 0 ? h + ":" : "") + (h > 0 ? String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
}
function cvUpdateProgress() {
  const v = $("#main-hybrid-video-node");
  if (!v || cvIsSeeking) return;
  const fill = $("#cv-progress-fill"), thumb = $("#cv-progress-thumb"), bufBar = $("#cv-progress-buffer");
  const elapsed = $("#cv-elapsed"), durText = $("#cv-duration-text");
  const liveProg = $("#cv-progress-live"), liveBtn = $("#cv-golive-btn");
  const dur = v.duration;
  const isLive = !isFinite(dur) || dur === Infinity;
  if (isLive) {
    if (liveProg) liveProg.style.display = "block";
    if (fill) fill.style.width = "0%";
    if (thumb) thumb.style.left = "0%";
    if (bufBar) bufBar.style.width = "0%";
    if (elapsed) elapsed.textContent = cvFmtTime(v.currentTime);
    if (durText) durText.textContent = "LIVE";
    try {
      if (v.seekable && v.seekable.length > 0) {
        const edge = v.seekable.end(v.seekable.length - 1);
        const lag = edge - v.currentTime;
        if (liveBtn) liveBtn.style.display = lag > 8 ? "flex" : "none";
      }
    } catch {}
  } else {
    if (liveProg) liveProg.style.display = "none";
    const frac = dur > 0 ? v.currentTime / dur : 0;
    if (fill) fill.style.width = frac * 100 + "%";
    if (thumb) thumb.style.left = frac * 100 + "%";
    if (elapsed) elapsed.textContent = cvFmtTime(v.currentTime);
    if (durText) durText.textContent = cvFmtTime(dur);
    try {
      if (v.buffered && v.buffered.length > 0 && bufBar) {
        bufBar.style.width = (v.buffered.end(v.buffered.length - 1) / dur) * 100 + "%";
      }
    } catch {}
    if (liveBtn) liveBtn.style.display = "none";
  }
}

// ── rewind / fast-forward / go-live / screenshot ──
function cvRewind() {
  const v = $("#main-hybrid-video-node");
  if (!v) return;
  v.currentTime = Math.max(0, v.currentTime - 10);
  cvShowToast("⏪ -10s");
}
function cvFastForward() {
  const v = $("#main-hybrid-video-node");
  if (!v) return;
  try {
    if (!isFinite(v.duration) && v.seekable && v.seekable.length > 0) {
      const edge = v.seekable.end(v.seekable.length - 1);
      v.currentTime = Math.min(edge, v.currentTime + 10);
      cvShowToast("⚡ +10s");
      return;
    }
  } catch {}
  if (isFinite(v.duration)) {
    v.currentTime = Math.min(v.duration, v.currentTime + 10);
    cvShowToast("⏩ +10s");
  }
}
function cvGoLive() {
  const v = $("#main-hybrid-video-node");
  if (!v) return;
  try {
    if (v.seekable && v.seekable.length > 0) {
      v.currentTime = v.seekable.end(v.seekable.length - 1) - 0.5;
      v.play();
      cvShowToast("🔴 Back to LIVE!");
      const btn = $("#cv-golive-btn");
      if (btn) btn.style.display = "none";
    }
  } catch { cvShowToast("Could not seek to live edge"); }
}
function cvTakeScreenshot() {
  const v = $("#main-hybrid-video-node");
  if (!v) return;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth || 1280;
    canvas.height = v.videoHeight || 720;
    canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
    const link = document.createElement("a");
    link.download = "screenshot-" + Date.now() + ".png";
    link.href = canvas.toDataURL("image/png");
    link.click();
    cvShowToast("📸 Screenshot saved!");
  } catch { cvShowToast("⚠ Screenshot failed (CORS)"); }
}

// ── icon/poster/loader helpers ──
function cvUpdateVolIcon(val, muted) {
  const icon = $("#cv-vol-icon");
  if (!icon) return;
  if (muted || val == 0) icon.className = "fa-solid fa-volume-xmark";
  else if (val < 0.4) icon.className = "fa-solid fa-volume-off";
  else if (val < 0.7) icon.className = "fa-solid fa-volume-low";
  else icon.className = "fa-solid fa-volume-high";
}
function cvUpdatePlayIcon() {
  const v = $("#main-hybrid-video-node");
  const icon = $("#cv-play-icon");
  if (!icon || !v) return;
  icon.className = v.paused ? "fa-solid fa-play" : "fa-solid fa-pause";
}
function cvShowLoader(show) {
  const l = $("#cv-loader");
  if (l) l.className = show ? "cv-loading-ring active" : "cv-loading-ring";
}
function cvHidePoster() { $("#cv-poster")?.classList.add("hidden"); }
function cvShowPoster() { $("#cv-poster")?.classList.remove("hidden"); }

function cvInitVideoEvents() {
  const v = $("#main-hybrid-video-node");
  const frame = $("#cv-player-frame");
  if (!v) return;
  v.onplay = () => { cvUpdatePlayIcon(); cvShowLoader(false); cvHidePoster(); };
  v.onpause = () => cvUpdatePlayIcon();
  v.onwaiting = () => cvShowLoader(true);
  v.oncanplay = () => { cvShowLoader(false); cvUpdateProgress(); };
  v.onerror = () => cvShowLoader(false);
  v.ontimeupdate = () => cvUpdateProgress();
  v.ondurationchange = () => cvUpdateProgress();
  if (frame && !frame._cvLeaveBound) {
    frame._cvLeaveBound = true;
    frame.addEventListener("mouseleave", () => {
      if (!document.fullscreenElement) {
        clearTimeout(cvControlsTimer);
        frame.classList.remove("controls-visible");
      }
    });
  }
}

// ── global mouse/touch → show controls, then auto-hide ──
document.addEventListener("mousemove", () => {
  const frame = $("#cv-player-frame");
  if (!frame) return;
  frame.classList.add("controls-visible");
  clearTimeout(cvControlsTimer);
  cvControlsTimer = setTimeout(() => frame.classList.remove("controls-visible"), 2500);
});
document.addEventListener("touchstart", () => {
  const frame = $("#cv-player-frame");
  if (!frame) return;
  frame.classList.add("controls-visible");
  clearTimeout(cvControlsTimer);
  cvControlsTimer = setTimeout(() => frame.classList.remove("controls-visible"), 2500);
});
document.addEventListener("dblclick", (e) => {
  const frame = $("#cv-player-frame");
  if (!frame || !frame.contains(e.target)) return;
  if (e.target.closest(".cv-controls-row") || e.target.closest(".cv-progress-wrap") || e.target.closest(".cv-topright-overlay")) return;
  cvToggleFullscreen();
});

// ── floating channel-list panel inside the player ──
function cvToggleChannelSidebar() {
  const panel = $("#cv-float-chlist");
  if (!panel) return;
  panel.classList.contains("open") ? cvCloseFloatChList() : cvOpenFloatChList();
}
function cvOpenFloatChList() {
  const panel = $("#cv-float-chlist");
  const btn = $("#cv-chlist-btn");
  if (!panel) return;
  cvRenderFloatChList("");
  panel.classList.add("open");
  btn?.classList.add("active");
  const inp = $("#cv-float-search");
  if (inp) { inp.value = ""; inp.focus(); }
}
function cvCloseFloatChList() {
  $("#cv-float-chlist")?.classList.remove("open");
  $("#cv-chlist-btn")?.classList.remove("active");
}
function cvRenderFloatChList(query) {
  const body = $("#cv-float-chlist-body");
  if (!body) return;
  const q = (query || "").toLowerCase().trim();
  const filtered = q ? CHANNELS.filter((c) => c.name.toLowerCase().includes(q)) : CHANNELS;
  body.innerHTML = "";
  if (!filtered.length) {
    body.innerHTML = `<div style="padding:20px;text-align:center;color:#555;font-size:12px;">No channels found</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  filtered.forEach((ch, idx) => {
    const item = document.createElement("div");
    item.className = "cv-float-ch-item" + (currentChannel && ch.id === currentChannel.id ? " active" : "");
    const logoHtml = ch.logo
      ? `<img class="cv-float-ch-logo" src="${ch.logo}" onerror="this.style.display='none';this.nextSibling.style.display='block'"><div class="cv-float-ch-logo-ph" style="display:none"></div>`
      : `<div class="cv-float-ch-logo-ph"></div>`;
    item.innerHTML = `
      <span class="cv-float-ch-num">${idx + 1}</span>
      ${logoHtml}
      <div class="cv-float-ch-info">
        <div class="cv-float-ch-name">${ch.name}</div>
        <div class="cv-float-ch-group">${ch.group}</div>
      </div>
      <span class="cv-float-status-dot"></span>`;
    item.onclick = () => { playChannel(ch); cvCloseFloatChList(); };
    frag.appendChild(item);
  });
  body.appendChild(frag);
}
function cvFloatChSearch(val) { cvRenderFloatChList(val); }

document.addEventListener("fullscreenchange", () => {
  const frame = $("#cv-player-frame");
  const icon = $("#cv-fs-icon");
  if (document.fullscreenElement) {
    if (icon) icon.className = "fa-solid fa-compress";
    if (frame) {
      frame.classList.add("controls-visible");
      clearTimeout(cvControlsTimer);
      cvControlsTimer = setTimeout(() => frame.classList.remove("controls-visible"), 2500);
    }
  } else {
    if (icon) icon.className = "fa-solid fa-expand";
    if (frame) { clearTimeout(cvControlsTimer); frame.classList.remove("controls-visible"); }
  }
});

// ── keyboard shortcuts (Space/M/F/P/Arrows/L/S) ──
document.addEventListener("keydown", (e) => {
  const tag = (e.target || e.srcElement).tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  const v = $("#main-hybrid-video-node");
  if (!v || (!v.src && !activeHlsEngineInstance)) return;
  switch (e.code) {
    case "Space": e.preventDefault(); cvTogglePlay(); break;
    case "KeyM": cvToggleMute(); break;
    case "KeyF": cvToggleFullscreen(); break;
    case "KeyP": cvTogglePip(); break;
    case "ArrowUp": {
      e.preventDefault();
      v.volume = Math.min(1, v.volume + 0.1);
      const s = $("#cv-vol-slider"); if (s) s.value = v.volume;
      cvShowToast("🔊 " + Math.round(v.volume * 100) + "%");
      break;
    }
    case "ArrowDown": {
      e.preventDefault();
      v.volume = Math.max(0, v.volume - 0.1);
      const s2 = $("#cv-vol-slider"); if (s2) s2.value = v.volume;
      cvShowToast("🔉 " + Math.round(v.volume * 100) + "%");
      break;
    }
    case "ArrowLeft": e.preventDefault(); cvRewind(); break;
    case "ArrowRight": e.preventDefault(); cvFastForward(); break;
    case "KeyL": cvGoLive(); break;
    case "KeyS": cvTakeScreenshot(); break;
  }
});

// ── live clock (Asia/Dhaka) above the player ──
function startBSTClockEngine() {
  function updateClock() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString("en-US", { timeZone: "Asia/Dhaka", hour12: true, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const el = $("#player-top-clock");
    if (el) el.textContent = timeStr;
  }
  updateClock();
  setInterval(updateClock, 1000);
}

function setupPlayerControls() {
  $("#closePlayer").addEventListener("click", closePlayer);
}

// ---------- INIT ----------
async function init() {
  setupSearch();
  setupSidebarToggle();
  setupZoneNav();
  setupPlayerControls();
  startBSTClockEngine();
  tickClock();
  setInterval(tickClock, 30000);

  setSplashProgress(20, "প্লেলিস্ট আনা হচ্ছে…");
  try {
    const text = await fetchPlaylist();
    setSplashProgress(65, "চ্যানেল সাজানো হচ্ছে…");
    CHANNELS = parseM3U(text);
    if (!CHANNELS.length) throw new Error("empty");

    const counts = buildGroups();
    renderSidebar(counts);
    renderCatSections(CHANNELS);
    renderFavRow();
    renderResumeRow();

    setSplashProgress(100, `${CHANNELS.length}টি চ্যানেল প্রস্তুত`);
    setTimeout(hideSplash, 350);
  } catch (e) {
    setSplashProgress(100, "লোড ব্যর্থ হয়েছে — আবার চেষ্টা করা হচ্ছে");
    setTimeout(() => location.reload(), 2500);
  }
}

document.addEventListener("DOMContentLoaded", init);
