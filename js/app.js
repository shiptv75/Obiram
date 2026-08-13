// ============================================================
// OBIRAM TV — app.js
// ============================================================

const M3U_URL = "https://raw.githubusercontent.com/shiptv75/SHIPTV/main/playlist.m3u";
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
let currentChannel = null;
let hls = null;
let mpegtsPlayer = null;
let currentSourceIndex = 0;
let retryTimer = null;

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
      const name = nameMatch ? nameMatch[1].trim() : "Unknown";
      const logoMatch = line.match(/tvg-logo="([^"]*)"/);
      const groupMatch = line.match(/group-title="([^"]*)"/);

      pending = {
        name: name || "Unknown",
        logo: logoMatch ? logoMatch[1] : "",
        group: groupMatch && groupMatch[1] ? groupMatch[1] : "অন্যান্য",
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
async function fetchPlaylist() {
  for (const wrap of CORS_PROXIES) {
    try {
      const res = await fetch(wrap(M3U_URL), { cache: "no-store" });
      if (!res.ok) throw new Error("bad status " + res.status);
      const text = await res.text();
      if (text && text.includes("#EXTM3U")) return text;
      if (text && text.includes("#EXTINF")) return text;
    } catch (e) {
      continue;
    }
  }
  throw new Error("প্লেলিস্ট লোড করা যায়নি");
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
    if (g === "__all__") {
      renderCatSections(CHANNELS);
    } else {
      document.getElementById("sec-" + slugify(g))?.scrollIntoView({ behavior: "smooth", block: "start" });
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

// ================= PLAYER =================
function openPlayer(chan) {
  currentChannel = chan;
  currentSourceIndex = 0;
  saveResume(chan);
  renderResumeRow();

  $("#playerOverlay").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  $("#playerName").textContent = chan.name;
  $("#playerLogo").src = chan.logo || "";
  $("#playerLogo").onerror = () => { $("#playerLogo").style.visibility = "hidden"; };
  $("#playerLogo").style.visibility = "visible";

  const favs = loadJSON(LS_FAV, []);
  $("#favBtn").classList.toggle("active", favs.includes(chan.id));

  // server select
  const serverSelect = $("#serverSelect");
  serverSelect.innerHTML = chan.sources
    .map((s, i) => `<option value="${i}">সার্ভার ${i + 1}</option>`)
    .join("");
  serverSelect.classList.toggle("hidden", chan.sources.length <= 1);

  loadSource(0);
}

function loadSource(index) {
  currentSourceIndex = index;
  const src = currentChannel.sources[index];
  if (!src) { showVideoError(); return; }

  cleanupPlayers();
  $("#videoError").classList.add("hidden");
  $("#videoLoading").classList.remove("hidden");
  $("#serverSelect").value = String(index);

  const video = $("#videoEl");
  const isTS = /\.ts(\?|$)/i.test(src) || src.includes("mpegts");

  try {
    if (isTS && window.mpegts && mpegts.isSupported()) {
      mpegtsPlayer = mpegts.createPlayer({ type: "mse", isLive: true, url: src });
      mpegtsPlayer.attachMediaElement(video);
      mpegtsPlayer.load();
      mpegtsPlayer.on(mpegts.Events.ERROR, () => tryNextSource());
      mpegtsPlayer.play().catch(() => {});
    } else if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: true });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (evt, data) => {
        if (data.fatal) tryNextSource();
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      video.addEventListener("loadedmetadata", () => video.play().catch(() => {}), { once: true });
    } else {
      video.src = src;
      video.play().catch(() => {});
    }
  } catch (e) {
    tryNextSource();
  }

  video.oncanplay = () => $("#videoLoading").classList.add("hidden");
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (video.readyState < 2) tryNextSource();
  }, 12000);
}

function tryNextSource() {
  clearTimeout(retryTimer);
  const next = currentSourceIndex + 1;
  if (currentChannel && next < currentChannel.sources.length) {
    toast(`সার্ভার ${next + 1} চেষ্টা করা হচ্ছে…`);
    loadSource(next);
  } else {
    showVideoError();
  }
}

function showVideoError() {
  $("#videoLoading").classList.add("hidden");
  $("#videoError").classList.remove("hidden");
}

function cleanupPlayers() {
  clearTimeout(retryTimer);
  const video = $("#videoEl");
  try { video.pause(); } catch {}
  video.removeAttribute("src");
  video.load();
  if (hls) { try { hls.destroy(); } catch {} hls = null; }
  if (mpegtsPlayer) { try { mpegtsPlayer.destroy(); } catch {} mpegtsPlayer = null; }
}

function closePlayer() {
  cleanupPlayers();
  $("#playerOverlay").classList.add("hidden");
  document.body.style.overflow = "";
  currentChannel = null;
}

function setupPlayerControls() {
  $("#closePlayer").addEventListener("click", closePlayer);
  $("#retryBtn").addEventListener("click", () => loadSource(currentSourceIndex));

  $("#serverSelect").addEventListener("change", (e) => loadSource(parseInt(e.target.value, 10)));

  $("#favBtn").addEventListener("click", () => {
    if (!currentChannel) return;
    toggleFav(currentChannel.id);
    $("#favBtn").classList.toggle("active");
    renderFavRow();
  });

  $("#shareBtn").addEventListener("click", async () => {
    if (!currentChannel) return;
    const url = `${location.origin}${location.pathname}#${currentChannel.id}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: currentChannel.name, text: `${currentChannel.name} - Obiram TV তে দেখুন`, url });
      } else {
        await navigator.clipboard.writeText(url);
        toast("লিংক কপি হয়েছে");
      }
    } catch {}
  });

  const video = $("#videoEl");
  const ppBtn = $("#ppBtn");
  ppBtn.addEventListener("click", () => {
    if (video.paused) video.play(); else video.pause();
  });
  video.addEventListener("play", () => {
    $("#ppIcon").innerHTML = `<rect x="5" y="4" width="4" height="16" fill="currentColor"/><rect x="15" y="4" width="4" height="16" fill="currentColor"/>`;
  });
  video.addEventListener("pause", () => {
    $("#ppIcon").innerHTML = `<path d="M6 4l14 8-14 8V4z" fill="currentColor"/>`;
  });

  const muteBtn = $("#muteBtn");
  muteBtn.addEventListener("click", () => {
    video.muted = !video.muted;
    muteBtn.classList.toggle("active", video.muted);
  });

  $("#volumeSlider").addEventListener("input", (e) => {
    video.volume = parseFloat(e.target.value);
    video.muted = video.volume === 0;
  });

  $("#aspectSelect").addEventListener("change", (e) => {
    video.classList.remove("obj-cover", "obj-fill");
    if (e.target.value === "cover") video.classList.add("obj-cover");
    if (e.target.value === "fill") video.classList.add("obj-fill");
  });

  $("#pipBtn").addEventListener("click", async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (video.requestPictureInPicture) {
        await video.requestPictureInPicture();
      } else {
        toast("এই ব্রাউজারে PiP সাপোর্ট নেই");
      }
    } catch { toast("PiP চালু করা যায়নি"); }
  });

  $("#fsBtn").addEventListener("click", () => {
    const shell = $(".player-shell");
    if (!document.fullscreenElement) shell.requestFullscreen?.();
    else document.exitFullscreen?.();
  });
}

// ---------- INIT ----------
async function init() {
  setupSearch();
  setupSidebarToggle();
  setupPlayerControls();
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
