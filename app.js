import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as tus from "https://esm.sh/tus-js-client@4";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const main = $("#main");
const modalRoot = $("#modal-root");
const toastNode = $("#toast");

const state = {
  supabase: null, backend: false, user: null, profile: null, videos: [],
  page: "home", selectedCategory: "All", search: "", watching: null,
  comments: [], liked: false, subscribed: false, uploadFile: null,
  thumbnailFile: null, authMode: "signin", sidebarCollapsed: false,
  toastTimer: null, seenThisSession: new Set()
};
const categories = ["All", "Music", "Gaming", "Roblox", "Education", "Technology", "Comedy", "Sports", "News", "Live", "Recently uploaded"];
const localDBName = "youtube-local-video-store";
const localStoreName = "videos";

function safeJSON(value, fallback) {
  try { const parsed = JSON.parse(value); return parsed == null ? fallback : parsed; }
  catch { return fallback; }
}
function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
function attr(value) { return esc(value); }
function initials(value) {
  const text = String(value || "Y").trim();
  return text ? text.slice(0, 1).toUpperCase() : "Y";
}
function formatCount(value) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
}
function timeAgo(date) {
  if (!date) return "just now";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return Math.floor(seconds / 60) + " minutes ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + " hours ago";
  if (seconds < 2592000) return Math.floor(seconds / 86400) + " days ago";
  if (seconds < 31536000) return Math.floor(seconds / 2592000) + " months ago";
  return Math.floor(seconds / 31536000) + " years ago";
}
function dateLabel(date) {
  if (!date) return "";
  return new Date(date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function durationLabel(seconds) {
  const n = Math.max(0, Math.floor(Number(seconds || 0)));
  if (!n) return "";
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60;
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") : m + ":" + String(s).padStart(2, "0");
}
function toast(message) {
  toastNode.textContent = message;
  toastNode.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toastNode.classList.remove("show"), 2800);
}
function readList(key) { return safeJSON(localStorage.getItem(key), []); }
function writeList(key, values) { localStorage.setItem(key, JSON.stringify(values)); }
function uniqueId() {
  return crypto && crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function openLocalDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(localDBName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(localStoreName)) db.createObjectStore(localStoreName, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open local video storage."));
  });
}
async function localDBRequest(mode, operation, value) {
  const db = await openLocalDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(localStoreName, mode);
    const store = transaction.objectStore(localStoreName);
    let request;
    if (operation === "getAll") request = store.getAll();
    else if (operation === "put") request = store.put(value);
    else if (operation === "delete") request = store.delete(value);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Local video storage failed."));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}
async function getLocalVideos() {
  const rows = await localDBRequest("readonly", "getAll");
  return (rows || []).map(row => ({
    ...row,
    videoUrl: URL.createObjectURL(row.fileBlob),
    thumbnailUrl: row.thumbBlob ? URL.createObjectURL(row.thumbBlob) : "",
    channelName: row.channelName || "Your channel",
    profileAvatar: "",
    views: Number(row.views || 0),
    likesCount: Number(row.likesCount || 0)
  })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
async function saveLocalVideo(row) { await localDBRequest("readwrite", "put", row); }
async function getLocalVideoRaw(id) {
  const db = await openLocalDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(localStoreName, "readonly");
    const request = tx.objectStore(localStoreName).get(id);
    request.onsuccess = () => { db.close(); resolve(request.result || null); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}
function getLocalUser() { return { id: "local-user", email: "demo@local", user_metadata: { username: "Your channel" } }; }
function channelName(video) {
  if (video.channelName) return video.channelName;
  if (video.profiles && video.profiles.username) return video.profiles.username;
  if (state.profile && video.user_id === state.user?.id) return state.profile.username || "Your channel";
  return "Creator";
}
function avatarMarkup(video, extraClass) {
  const avatar = video.profileAvatar || (video.profiles && video.profiles.avatar_url) || "";
  return '<span class="' + (extraClass || "card-avatar") + '">' + (avatar ? '<img src="' + attr(avatar) + '" alt="">' : esc(initials(channelName(video)))) + '</span>';
}
function getVideoUrl(video) {
  if (video.videoUrl) return video.videoUrl;
  if (video.storage_path && state.supabase) return state.supabase.storage.from("videos").getPublicUrl(video.storage_path).data.publicUrl;
  return "";
}
function getThumbnailUrl(video) {
  if (video.thumbnailUrl) return video.thumbnailUrl;
  if (video.thumbnail_path && state.supabase) return state.supabase.storage.from("thumbnails").getPublicUrl(video.thumbnail_path).data.publicUrl;
  return "";
}
function mapRemoteVideo(row) {
  return {
    ...row,
    videoUrl: row.storage_path ? state.supabase.storage.from("videos").getPublicUrl(row.storage_path).data.publicUrl : "",
    thumbnailUrl: row.thumbnail_path ? state.supabase.storage.from("thumbnails").getPublicUrl(row.thumbnail_path).data.publicUrl : "",
    channelName: row.profiles && row.profiles.username ? row.profiles.username : "Creator",
    profileAvatar: row.profiles && row.profiles.avatar_url ? row.profiles.avatar_url : "",
    views: Number(row.views || 0),
    likesCount: Number(row.likes_count || 0),
    createdAt: row.created_at
  };
}
async function loadVideos() {
  if (!state.backend) { state.videos = await getLocalVideos(); return; }
  const { data, error } = await state.supabase.from("videos").select("*, profiles(username, avatar_url)").eq("visibility", "public").order("created_at", { ascending: false }).limit(80);
  if (error) throw error;
  state.videos = (data || []).map(mapRemoteVideo);
}
async function loadProfile() {
  if (!state.backend || !state.user) { state.profile = null; return; }
  const { data } = await state.supabase.from("profiles").select("*").eq("id", state.user.id).maybeSingle();
  state.profile = data || { id: state.user.id, username: state.user.email ? state.user.email.split("@")[0] : "Creator" };
}
function setTheme(theme) {
  const next = theme || localStorage.getItem("youtube-theme") || "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("youtube-theme", next);
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = next === "dark" ? "#0f0f0f" : "#ffffff";
}
function renderHeader() {
  const userName = state.profile?.username || (state.user?.email ? state.user.email.split("@")[0] : "Your channel");
  const account = state.backend && state.user
    ? '<button class="icon-btn avatar" data-action="account" aria-label="Account">' + esc(initials(userName)) + '</button>'
    : '<button class="signin-btn" data-action="sign-in">Sign in</button>';
  $("#topbar").innerHTML =
    '<div class="top-left"><button class="icon-btn" data-action="toggle-sidebar" aria-label="Toggle menu">☰</button>' +
    '<a class="brand" href="#home" data-action="go-home"><span class="brand-mark">▶</span><span class="brand-word">YouTube</span><span class="brand-country">PK</span></a></div>' +
    '<div class="top-center"><div class="search-wrap"><input id="search-input" class="search-input" type="search" placeholder="Search" value="' + attr(state.search) + '" aria-label="Search videos"><button class="search-submit" data-action="search" aria-label="Search">⌕</button></div><button class="icon-btn voice-btn" data-action="voice-search" aria-label="Voice search">🎙</button></div>' +
    '<div class="top-right"><button class="create-btn" data-action="show-upload"><span class="create-symbol">＋</span><span>Create</span></button><button class="icon-btn" data-action="notifications" aria-label="Notifications">♧</button>' +
    '<button class="icon-btn" data-action="theme" aria-label="Toggle theme">' + (document.documentElement.dataset.theme === "dark" ? "☀" : "☾") + '</button>' + account + '</div>';
}
function renderSidebar() {
  const side = $("#sidebar");
  side.classList.toggle("collapsed", state.sidebarCollapsed);
  const item = (label, icon, action, active) =>
    '<button class="nav-item ' + (active ? "active" : "") + '" data-action="' + action + '" title="' + label + '"><span class="nav-icon">' + icon + '</span><span>' + label + '</span></button>';
  side.innerHTML =
    '<div class="nav-group primary">' +
    item("Home", "⌂", "go-home", state.page === "home") +
    item("Shorts", "▱", "go-shorts", state.page === "shorts") +
    item("Subscriptions", "▣", "go-subscriptions", state.page === "subscriptions") +
    '</div><div class="nav-group"><div class="nav-heading">You　›</div>' +
    item("Your channel", "◉", "go-profile", state.page === "profile" || state.page === "channel") +
    item("History", "◷", "go-history", state.page === "history") +
    item("Watch later", "◴", "go-watch-later", state.page === "watch-later") +
    '</div><div class="nav-group">' + item("Create", "＋", "show-upload", false) + item("Settings", "⚙", "settings", false) +
    '</div><div class="sidebar-note">Explore videos, share your own work and build a community around your channel.</div>';
}
function renderMobileNav() {
  const item = (label, icon, action, active) =>
    '<button class="nav-item ' + (active ? "active" : "") + '" data-action="' + action + '"><span class="nav-icon">' + icon + '</span><span>' + label + '</span></button>';
  $("#mobile-nav").innerHTML = item("Home", "⌂", "go-home", state.page === "home") +
    item("Shorts", "▱", "go-shorts", state.page === "shorts") + item("Create", "＋", "show-upload", false) +
    item("Subs", "▣", "go-subscriptions", state.page === "subscriptions") +
    item("You", "◉", "go-profile", ["profile", "history", "watch-later"].includes(state.page));
}
function renderShell() { renderHeader(); renderSidebar(); renderMobileNav(); }
function videoCard(video) {
  const thumb = getThumbnailUrl(video), duration = durationLabel(video.duration_seconds);
  const views = formatCount(video.views) + (Number(video.views) === 1 ? " view" : " views");
  return '<article class="video-card" data-action="open-video" data-id="' + attr(video.id) + '">' +
    '<div class="thumb">' + (thumb ? '<img src="' + attr(thumb) + '" alt="" loading="lazy">' : '<span class="thumb-placeholder">▶</span>') +
    (duration ? '<span class="duration">' + esc(duration) + '</span>' : '') + '</div><div class="card-details">' + avatarMarkup(video) +
    '<div class="card-copy"><h3 class="card-title">' + esc(video.title) + '</h3><div class="card-meta">' + esc(channelName(video)) + '<br>' + views + ' · ' + esc(timeAgo(video.createdAt || video.created_at)) + '</div></div>' +
    '<button class="card-menu" data-action="video-menu" data-id="' + attr(video.id) + '" aria-label="More options">⋮</button></div></article>';
}
function emptyState(title, message, buttonText, actionName, icon) {
  return '<section class="empty-state"><div class="empty-icon">' + (icon || "▶") + '</div><h1>' + esc(title) + '</h1><p>' + esc(message) + '</p>' +
    (buttonText ? '<button class="primary-btn" data-action="' + actionName + '">' + esc(buttonText) + '</button>' : '') + '</section>';
}
function visibleVideos() {
  let rows = state.videos.slice();
  if (state.selectedCategory !== "All") {
    if (state.selectedCategory === "Recently uploaded") rows = rows.filter(v => Date.now() - new Date(v.createdAt || v.created_at).getTime() < 7 * 86400000);
    else rows = rows.filter(v => String(v.category || "").toLowerCase() === state.selectedCategory.toLowerCase());
  }
  if (state.search.trim()) {
    const q = state.search.trim().toLowerCase();
    rows = rows.filter(v => [v.title, v.description, v.category, channelName(v)].join(" ").toLowerCase().includes(q));
  }
  return rows;
}
function renderHome() {
  const chips = '<div class="chip-row">' + categories.map(c => '<button class="chip ' + (state.selectedCategory === c ? "active" : "") + '" data-action="category" data-category="' + attr(c) + '">' + esc(c) + '</button>').join("") + '</div>';
  const videos = visibleVideos();
  if (!videos.length) {
    if (state.search.trim()) return chips + emptyState("No videos found", "Try a different search, or clear the search box to see the full feed.", "Clear search", "clear-search", "⌕");
    if (state.selectedCategory !== "All") return chips + emptyState("Nothing here yet", "There are no videos in this category yet. Check another category or upload the first one.", "Upload a video", "show-upload", "▱");
    return chips + emptyState("Your video feed is empty", "There are no videos yet. Be the first creator: upload a video and it will appear here. Shared uploads become visible after the backend is connected.", "＋ Upload your first video", "show-upload", "▶");
  }
  return chips + '<div class="video-grid">' + videos.map(videoCard).join("") + '</div>';
}
function renderShorts() {
  const shorts = state.videos.filter(v => v.is_short);
  if (!shorts.length) return emptyState("No Shorts yet", "Short vertical videos will appear here. Upload a vertical clip and mark it as a Short.", "Create a Short", "show-upload", "▯");
  return '<div class="page-heading"><h1>Shorts</h1><button class="primary-btn" data-action="show-upload">＋ Create</button></div><div class="shorts-grid">' +
    shorts.map(v => '<article class="short-card" data-action="open-video" data-id="' + attr(v.id) + '"><div class="short-thumb">' +
      (getThumbnailUrl(v) ? '<img src="' + attr(getThumbnailUrl(v)) + '" alt="" loading="lazy">' : '<div class="thumb-placeholder">▶</div>') +
      '<span class="duration">' + esc(durationLabel(v.duration_seconds)) + '</span></div><div class="short-copy">' + esc(v.title) + '</div><div class="short-meta">' + formatCount(v.views) + ' views · ' + esc(channelName(v)) + '</div></article>'
    ).join("") + '</div>';
}
async function loadLibraryRows(type) {
  if (type === "history") return readList("youtube-history").map(id => state.videos.find(v => v.id === id)).filter(Boolean);
  if (type === "watch-later") return readList("youtube-watch-later").map(id => state.videos.find(v => v.id === id)).filter(Boolean);
  if (type === "profile") {
    if (!state.backend) return state.videos.filter(v => v.user_id === "local-user");
    if (!state.user) return [];
    const { data, error } = await state.supabase.from("videos").select("*, profiles(username, avatar_url)").eq("user_id", state.user.id).order("created_at", { ascending: false });
    if (error) { console.error(error); return []; }
    return (data || []).map(mapRemoteVideo);
  }
  if (type === "subscriptions" && state.backend && state.user) {
    const { data } = await state.supabase.from("subscriptions").select("channel_id").eq("subscriber_id", state.user.id);
    const ids = (data || []).map(item => item.channel_id);
    return state.videos.filter(v => ids.includes(v.user_id));
  }
  if (type === "subscriptions" && !state.backend) return state.videos.filter(v => readList("youtube-local-subs").includes(v.user_id));
  return [];
}
function libraryRow(video) {
  const thumb = getThumbnailUrl(video);
  return '<div class="library-row" data-action="open-video" data-id="' + attr(video.id) + '"><div class="thumb">' +
    (thumb ? '<img src="' + attr(thumb) + '" alt="" loading="lazy">' : '<span class="thumb-placeholder">▶</span>') +
    '<span class="duration">' + esc(durationLabel(video.duration_seconds)) + '</span></div><div class="card-copy"><h3 class="card-title">' +
    esc(video.title) + '</h3><div class="card-meta">' + esc(channelName(video)) + '<br>' + formatCount(video.views) + ' views · ' +
    esc(timeAgo(video.createdAt || video.created_at)) + '</div></div></div>';
}
async function renderLibrary(type) {
  const titles = { history: "History", "watch-later": "Watch later", profile: "Your channel", subscriptions: "Subscriptions" };
  const rows = await loadLibraryRows(type);
  const heading = '<div class="page-heading"><h1>' + esc(titles[type] || "Library") + '</h1>' +
    (type === "profile" ? '<button class="primary-btn" data-action="show-upload">＋ Create</button>' : '') + '</div>';
  if (type === "profile") {
    const name = state.profile?.username || (state.user?.email ? state.user.email.split("@")[0] : "Your channel");
    const description = state.backend ? "Your videos and creator activity" : "Local demo channel · videos are stored only in this browser";
    const hero = '<div class="channel-banner"></div><div class="channel-hero"><span class="avatar">' + esc(initials(name)) + '</span><div><h1>' + esc(name) +
      '</h1><p>' + (state.backend ? "@" + esc(name) + " · " : "") + rows.length + ' videos<br>' + esc(description) + '</p></div></div>';
    return heading + hero + (rows.length ? '<div class="video-grid">' + rows.map(videoCard).join("") + '</div>' :
      emptyState("Your channel is ready", "You have not uploaded any videos yet. Publish your first video to start building your channel.", "Upload video", "show-upload", "◉"));
  }
  if (!rows.length) {
    const descriptions = {
      history: "Videos you watch will show up here.",
      "watch-later": "Save videos to watch them later.",
      subscriptions: state.user ? "New videos from channels you subscribe to will appear here." : "Sign in after connecting the backend to follow channels and see their latest videos."
    };
    return heading + emptyState("Nothing to show yet", descriptions[type] || "This section is empty.", type === "history" ? "Explore videos" : "Browse videos", "go-home", "◷");
  }
  return heading + '<div class="library-list">' + rows.map(libraryRow).join("") + '</div>';
}
function renderWatch() {
  const video = state.watching;
  if (!video) return emptyState("Video not found", "This video may have been removed or is not available in the current feed.", "Go to home", "go-home", "▶");
  const source = getVideoUrl(video), description = video.description || "No description has been added.";
  const owner = channelName(video), isOwner = state.user && video.user_id === state.user.id;
  const related = state.videos.filter(v => v.id !== video.id).slice(0, 8);
  const userName = state.profile?.username || (state.user?.email ? state.user.email.split("@")[0] : "Your channel");
  const upNext = related.length ? '<aside class="up-next"><h2 class="section-title">Up next</h2>' + related.map(v =>
    '<div class="side-video" data-action="open-video" data-id="' + attr(v.id) + '"><div class="side-thumb">' +
    (getThumbnailUrl(v) ? '<img src="' + attr(getThumbnailUrl(v)) + '" alt="" loading="lazy">' : '<span>▶</span>') +
    '<span class="duration">' + esc(durationLabel(v.duration_seconds)) + '</span></div><div class="side-copy"><p class="side-title">' + esc(v.title) +
    '</p><div class="side-meta">' + esc(channelName(v)) + '<br>' + formatCount(v.views) + ' views</div></div></div>'
  ).join("") + '</aside>' : '<aside class="up-next"><h2 class="section-title">Up next</h2><p class="watch-empty">More videos will appear here when creators upload them.</p></aside>';
  return '<div class="watch-layout"><section class="watch-main"><div class="player-frame">' +
    (source ? '<video id="watch-player" src="' + attr(source) + '" controls playsinline preload="metadata" poster="' + attr(getThumbnailUrl(video)) + '"></video>' : '<div class="thumb-placeholder">Video unavailable</div>') +
    '</div><h1 class="watch-title">' + esc(video.title) + '</h1><div class="watch-actions"><div class="channel-row">' +
    '<button class="channel-avatar" data-action="open-channel" data-id="' + attr(video.user_id || "local-user") + '">' + esc(initials(owner)) + '</button>' +
    '<div><div class="channel-name">' + esc(owner) + '</div><div class="channel-subs">' + formatCount(video.subscribers_count || 0) + ' subscribers</div></div>' +
    (isOwner ? '' : '<button class="subscribe-btn ' + (state.subscribed ? "subscribed" : "") + '" data-action="subscribe">' + (state.subscribed ? "Subscribed" : "Subscribe") + '</button>') +
    '</div><div class="action-pills"><button class="action-pill" data-action="like">' + (state.liked ? "👍 Liked" : "👍 Like") + ' · ' + formatCount(video.likesCount || video.likes_count || 0) + '</button>' +
    '<button class="action-pill" data-action="share">↗ Share</button><button class="action-pill" data-action="watch-later-toggle">◷ Save</button>' +
    '<button class="action-pill" data-action="video-menu">⋯</button></div></div>' +
    '<div class="video-description"><div class="description-top">' + formatCount(video.views) + ' views · ' + esc(dateLabel(video.createdAt || video.created_at)) + '</div>' + esc(description) + '</div>' +
    '<section class="comments"><div class="comments-head"><h2>' + state.comments.length + ' comments</h2><span class="card-meta">Join the conversation</span></div>' +
    '<form id="comment-form" class="comment-form"><span class="avatar">' + esc(initials(userName)) + '</span><input name="comment" maxlength="1000" placeholder="Add a comment…" aria-label="Add a comment" required><button class="primary-btn" type="submit">Comment</button></form>' +
    (state.comments.length ? state.comments.map(comment => '<article class="comment"><span class="card-avatar">' + esc(initials(comment.author || "Creator")) +
      '</span><div class="comment-body"><div class="comment-author">' + esc(comment.author || "Creator") + '<span class="comment-date">' +
      esc(timeAgo(comment.created_at || comment.createdAt)) + '</span></div><div>' + esc(comment.body) + '</div></div></article>').join("") :
      '<p class="watch-empty">No comments yet. Be the first to comment.</p>') +
    '</section></section>' + upNext + '</div>';
}
function renderMain() {
  if (state.page === "watch") { main.innerHTML = renderWatch(); return; }
  if (state.page === "shorts") { main.innerHTML = renderShorts(); return; }
  if (state.page === "profile") { renderLibrary("profile").then(html => { if (state.page === "profile") main.innerHTML = html; }); return; }
  if (["history", "watch-later", "subscriptions"].includes(state.page)) {
    renderLibrary(state.page).then(html => { if (["history", "watch-later", "subscriptions"].includes(state.page)) main.innerHTML = html; });
    return;
  }
  if (state.page === "channel") { renderChannel(); return; }
  main.innerHTML = renderHome();
}
async function renderChannel() {
  const channelId = state.channelId;
  let videos = state.videos.filter(v => v.user_id === channelId);
  let name = videos[0] ? channelName(videos[0]) : "Channel";
  if (state.backend && channelId) {
    const { data: profile } = await state.supabase.from("profiles").select("*").eq("id", channelId).maybeSingle();
    if (profile) name = profile.username || name;
    const { data } = await state.supabase.from("videos").select("*, profiles(username, avatar_url)").eq("user_id", channelId).eq("visibility", "public").order("created_at", { ascending: false });
    videos = (data || []).map(mapRemoteVideo);
  }
  if (state.page !== "channel") return;
  main.innerHTML = '<div class="channel-banner"></div><div class="channel-hero"><span class="avatar">' + esc(initials(name)) +
    '</span><div><h1>' + esc(name) + '</h1><p>' + videos.length + ' public videos</p></div></div>' +
    (videos.length ? '<div class="video-grid">' + videos.map(videoCard).join("") + '</div>' : emptyState("No public videos yet", "This channel has not published any videos.", "", "", "▶"));
}
async function loadWatchDetails(id) {
  let video = state.videos.find(v => v.id === id);
  if (!video && state.backend) {
    const { data, error } = await state.supabase.from("videos").select("*, profiles(username, avatar_url)").eq("id", id).maybeSingle();
    if (!error && data) video = mapRemoteVideo(data);
  }
  state.watching = video || null;
  state.comments = [];
  state.liked = false;
  state.subscribed = false;
  if (!video) { renderMain(); return; }
  writeList("youtube-history", [id].concat(readList("youtube-history").filter(x => x !== id)).slice(0, 100));
  if (state.backend) {
    if (state.user) {
      const [likeResult, subResult] = await Promise.all([
        state.supabase.from("video_likes").select("video_id").eq("video_id", id).eq("user_id", state.user.id).maybeSingle(),
        state.supabase.from("subscriptions").select("channel_id").eq("channel_id", video.user_id).eq("subscriber_id", state.user.id).maybeSingle()
      ]);
      state.liked = !!likeResult.data;
      state.subscribed = !!subResult.data;
    }
    const { data: comments } = await state.supabase.from("comments").select("*, profiles(username, avatar_url)").eq("video_id", id).order("created_at", { ascending: false }).limit(100);
    state.comments = (comments || []).map(c => ({ ...c, author: c.profiles?.username || "Creator" }));
  } else {
    state.liked = readList("youtube-local-likes").includes(id);
    state.comments = safeJSON(localStorage.getItem("youtube-comments-" + id), []);
  }
  renderMain();
  recordView(video);
}
function visitorId() {
  let id = localStorage.getItem("youtube-visitor-id");
  if (!id) { id = uniqueId(); localStorage.setItem("youtube-visitor-id", id); }
  return id;
}
async function recordView(video) {
  if (state.seenThisSession.has(video.id)) return;
  state.seenThisSession.add(video.id);
  if (state.backend) {
    const { error } = await state.supabase.from("video_views").insert({ video_id: video.id, visitor_id: visitorId() });
    if (error && !String(error.code || "").includes("23505")) console.warn("View was not recorded:", error.message);
    const { data } = await state.supabase.from("videos").select("views").eq("id", video.id).maybeSingle();
    if (data && state.watching && state.watching.id === video.id) {
      state.watching.views = data.views;
      const row = state.videos.find(v => v.id === video.id);
      if (row) row.views = data.views;
      renderMain();
    }
    return;
  }
  const raw = await getLocalVideoRaw(video.id);
  if (raw) {
    raw.views = Number(raw.views || 0) + 1;
    await saveLocalVideo(raw);
    const row = state.videos.find(v => v.id === video.id);
    if (row) row.views = raw.views;
    if (state.watching && state.watching.id === video.id) state.watching.views = raw.views;
    renderMain();
  }
}
function setPage(page) {
  state.page = page;
  state.selectedCategory = "All";
  state.search = "";
  const hashes = { home: "#home", shorts: "#shorts", profile: "#you", history: "#history", "watch-later": "#watch-later", subscriptions: "#subscriptions" };
  if (hashes[page]) history.replaceState(null, "", hashes[page]);
  renderShell(); renderMain(); window.scrollTo({ top: 0, behavior: "instant" });
}
function openVideo(id) {
  state.page = "watch";
  state.search = "";
  if (location.hash !== "#watch/" + id) history.pushState(null, "", "#watch/" + id);
  renderShell(); loadWatchDetails(id); window.scrollTo({ top: 0, behavior: "instant" });
}
function parseRoute() {
  const hash = location.hash.replace(/^#/, "");
  if (hash.startsWith("watch/")) {
    state.page = "watch"; renderShell(); loadWatchDetails(decodeURIComponent(hash.slice(6)));
  } else if (hash.startsWith("channel/")) {
    state.page = "channel"; state.channelId = decodeURIComponent(hash.slice(8)); renderShell(); renderChannel();
  } else {
    const pages = { shorts: "shorts", you: "profile", history: "history", "watch-later": "watch-later", subscriptions: "subscriptions" };
    state.page = pages[hash] || "home"; renderShell(); renderMain();
  }
}
function openChannel(id) {
  state.page = "channel"; state.channelId = id;
  history.pushState(null, "", "#channel/" + encodeURIComponent(id));
  renderShell(); renderChannel();
}
function openUploadModal() {
  if (state.backend && !state.user) { openAuthModal("signin"); toast("Sign in to upload a video."); return; }
  state.uploadFile = null; state.thumbnailFile = null;
  modalRoot.innerHTML = '<div class="modal-backdrop" data-action="close-modal"><section class="modal wide" role="dialog" aria-modal="true" aria-labelledby="upload-title" data-modal-content>' +
    '<div class="modal-head"><h2 id="upload-title">Upload video</h2><button class="modal-close" data-action="close-modal" aria-label="Close">×</button></div>' +
    '<form id="upload-form"><div class="upload-drop"><div style="font-size:38px">⇧</div><strong>Choose a video to upload</strong><p class="field-help" id="video-file-label">MP4, WebM or MOV · maximum 50 MB</p><progress id="upload-progress" max="100" value="0" hidden style="width:100%;margin-top:12px"></progress><p class="field-help" id="upload-progress-label" aria-live="polite"></p><label class="primary-btn" for="video-file">Select video</label><input id="video-file" type="file" accept="video/*" hidden required></div>' +
    '<div class="field"><label for="video-title">Title</label><input id="video-title" name="title" maxlength="100" placeholder="Add a title that describes your video" required></div>' +
    '<div class="field"><label for="video-description">Description</label><textarea id="video-description" name="description" maxlength="5000" placeholder="Tell viewers about your video"></textarea></div>' +
    '<div class="form-row"><div class="field"><label for="video-category">Category</label><select id="video-category" name="category">' +
    categories.filter(c => c !== "All" && c !== "Recently uploaded").map(c => '<option value="' + attr(c) + '">' + esc(c) + '</option>').join("") +
    '</select></div><div class="field"><label for="video-visibility">Visibility</label><select id="video-visibility" name="visibility"><option value="public">Public</option><option value="unlisted">Unlisted</option></select></div></div>' +
    '<div class="field"><label for="thumbnail-file">Custom thumbnail (optional)</label><input id="thumbnail-file" type="file" accept="image/*"><span class="field-help">A clear thumbnail helps viewers understand what your video is about.</span><img id="thumbnail-preview" class="upload-preview" hidden alt="Thumbnail preview"></div>' +
    '<label class="field" style="flex-direction:row;align-items:center"><input id="is-short" type="checkbox" style="width:auto;min-height:0"> This is a vertical Short</label>' +
    '<div class="info-banner">By publishing, you confirm you have the rights to share this video and that it follows the platform rules.</div>' +
    '<div class="modal-actions"><button type="button" class="secondary-btn" data-action="close-modal">Cancel</button><button type="submit" class="primary-btn" id="publish-button">Publish</button></div></form></section></div>';
}
function openAuthModal(mode) {
  state.authMode = mode || "signin";
  if (!state.backend) {
    modalRoot.innerHTML = '<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" data-modal-content><div class="modal-head"><h2>Accounts are not connected yet</h2><button class="modal-close" data-action="close-modal">×</button></div><p>Demo mode lets you upload and watch videos on this browser. To use shared accounts, uploads and comments across devices, connect this app to a separate Supabase project.</p><div class="modal-actions"><button class="primary-btn" data-action="close-modal">Got it</button></div></section></div>';
    return;
  }
  renderAuthModal();
}
function renderAuthModal() {
  const signup = state.authMode === "signup";
  modalRoot.innerHTML = '<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="auth-title" data-modal-content>' +
    '<div class="modal-head"><h2 id="auth-title">' + (signup ? "Create your account" : "Sign in") + '</h2><button class="modal-close" data-action="close-modal">×</button></div>' +
    '<div class="auth-tabs"><button class="auth-tab ' + (!signup ? "active" : "") + '" data-action="auth-mode" data-mode="signin">Sign in</button><button class="auth-tab ' + (signup ? "active" : "") + '" data-action="auth-mode" data-mode="signup">Create account</button></div>' +
    '<form id="auth-form">' + (signup ? '<div class="field"><label for="auth-username">Channel name</label><input id="auth-username" name="username" maxlength="24" placeholder="Your channel name" required></div>' : '') +
    '<div class="field"><label for="auth-email">Email</label><input id="auth-email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required></div>' +
    '<div class="field"><label for="auth-password">Password</label><input id="auth-password" name="password" type="password" autocomplete="' + (signup ? "new-password" : "current-password") + '" minlength="8" placeholder="At least 8 characters" required></div>' +
    '<p class="field-help">Use an email address you control. Never share your password with anyone.</p><div class="modal-actions"><button type="button" class="secondary-btn" data-action="close-modal">Cancel</button><button type="submit" class="primary-btn">' +
    (signup ? "Create account" : "Sign in") + '</button></div></form></section></div>';
}
function closeModal() { modalRoot.innerHTML = ""; }
async function uploadVideoObject(path, file) {
  const { data: sessionData, error: sessionError } = await state.supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const session = sessionData.session;
  if (!session?.access_token) throw new Error("Your sign-in session expired. Sign in again and retry.");

  const config = window.APP_CONFIG || {};
  const projectId = new URL(config.supabaseUrl).hostname.split(".")[0];
  const progress = $("#upload-progress");
  const progressLabel = $("#upload-progress-label");

  if (file.size <= 6 * 1024 * 1024) {
    if (progress) progress.hidden = true;
    const { error } = await state.supabase.storage.from("videos").upload(path, file, {
      cacheControl: "3600", upsert: false, contentType: file.type
    });
    if (error) throw error;
    return;
  }

  if (progress) {
    progress.hidden = false;
    progress.value = 0;
  }
  if (progressLabel) progressLabel.textContent = "Starting a resumable upload…";

  await new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: "https://" + projectId + ".storage.supabase.co/storage/v1/upload/resumable",
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        authorization: "Bearer " + session.access_token,
        apikey: config.supabaseAnonKey
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: 6 * 1024 * 1024,
      metadata: {
        bucketName: "videos",
        objectName: path,
        contentType: file.type,
        cacheControl: "3600"
      },
      onError(error) {
        reject(error);
      },
      onProgress(bytesUploaded, bytesTotal) {
        const percentage = Math.min(100, Math.round((bytesUploaded / bytesTotal) * 100));
        if (progress) progress.value = percentage;
        if (progressLabel) progressLabel.textContent = percentage + "% uploaded";
      },
      onSuccess() {
        if (progress) progress.value = 100;
        if (progressLabel) progressLabel.textContent = "Upload complete. Publishing video details…";
        resolve();
      }
    });

    upload.findPreviousUploads().then(previousUploads => {
      if (previousUploads.length) upload.resumeFromPreviousUpload(previousUploads[0]);
      upload.start();
    }).catch(reject);
  });
}

async function publishVideo(form) {
  const title = String(form.get("title") || "").trim();
  const description = String(form.get("description") || "").trim();
  const category = String(form.get("category") || "Other");
  const visibility = String(form.get("visibility") || "public");
  const isShort = $("#is-short")?.checked || false;
  const file = state.uploadFile;
  if (!file) { toast("Choose a video file first."); return; }
  if (!file.type.startsWith("video/")) { toast("Choose a valid video file."); return; }
  if (file.size > 50 * 1024 * 1024) { toast("This demo is limited to videos up to 50 MB."); return; }
  if (!title) { toast("Add a title for your video."); return; }
  const button = $("#publish-button");
  button.disabled = true; button.textContent = "Publishing…";
  try {
    if (state.backend) {
      if (!state.user) throw new Error("Sign in before uploading.");
      const extension = (file.name.split(".").pop() || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "");
      const videoPath = state.user.id + "/" + uniqueId() + "." + extension;
      await uploadVideoObject(videoPath, file);
      let thumbnailPath = null;
      if (state.thumbnailFile) {
        const thumbExt = (state.thumbnailFile.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
        thumbnailPath = state.user.id + "/" + uniqueId() + "." + thumbExt;
        const { error: thumbError } = await state.supabase.storage.from("thumbnails").upload(thumbnailPath, state.thumbnailFile, { cacheControl: "3600", upsert: false, contentType: state.thumbnailFile.type });
        if (thumbError) throw thumbError;
      }
      const { error: insertError } = await state.supabase.from("videos").insert({
        user_id: state.user.id, title, description, category, storage_path: videoPath,
        thumbnail_path: thumbnailPath, visibility, is_short: isShort, duration_seconds: 0
      });
      if (insertError) throw insertError;
    } else {
      const videoUrl = URL.createObjectURL(file);
      const duration = await readVideoDuration(videoUrl);
      const row = {
        id: uniqueId(), user_id: "local-user", title, description, category, visibility, is_short: isShort,
        fileBlob: file, thumbBlob: state.thumbnailFile, duration_seconds: duration,
        views: 0, likesCount: 0, channelName: "Your channel", createdAt: new Date().toISOString()
      };
      await saveLocalVideo(row);
      URL.revokeObjectURL(videoUrl);
    }
    closeModal();
    await loadVideos();
    state.page = "home"; state.selectedCategory = "All"; state.search = "";
    renderShell(); renderMain(); toast("Your video has been published.");
  } catch (error) {
    console.error(error);
    toast(error.message || "Upload failed. Check your connection and storage settings.");
    button.disabled = false; button.textContent = "Publish";
  }
}
function readVideoDuration(url) {
  return new Promise(resolve => {
    const video = document.createElement("video");
    video.preload = "metadata"; video.src = url;
    video.onloadedmetadata = () => resolve(Number.isFinite(video.duration) ? Math.round(video.duration) : 0);
    video.onerror = () => resolve(0);
  });
}
async function handleAuth(form) {
  const data = new FormData(form);
  const email = String(data.get("email") || "").trim(), password = String(data.get("password") || "");
  try {
    let result;
    if (state.authMode === "signup") {
      const username = String(data.get("username") || "").trim();
      if (username.length < 3) throw new Error("Channel name must be at least 3 characters.");
      result = await state.supabase.auth.signUp({ email, password, options: { data: { username } } });
      if (result.error) throw result.error;
      closeModal();
      if (!result.data.session) toast("Check your email to confirm your account, then sign in.");
      else toast("Your account is ready.");
    } else {
      result = await state.supabase.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      closeModal(); toast("You are signed in.");
    }
    if (result.data.user) state.user = result.data.user;
    await loadProfile(); renderShell(); renderMain();
  } catch (error) { toast(error.message || "Could not sign in."); }
}
async function toggleLike() {
  const video = state.watching;
  if (!video) return;
  if (state.backend) {
    if (!state.user) { openAuthModal("signin"); toast("Sign in to like videos."); return; }
    if (state.liked) {
      const { error } = await state.supabase.from("video_likes").delete().eq("video_id", video.id).eq("user_id", state.user.id);
      if (error) { toast(error.message); return; }
      state.liked = false;
    } else {
      const { error } = await state.supabase.from("video_likes").insert({ video_id: video.id, user_id: state.user.id });
      if (error) { toast(error.message); return; }
      state.liked = true;
    }
    const { data } = await state.supabase.from("videos").select("likes_count").eq("id", video.id).maybeSingle();
    if (data) { video.likesCount = data.likes_count; video.likes_count = data.likes_count; }
  } else {
    const liked = readList("youtube-local-likes");
    if (liked.includes(video.id)) {
      writeList("youtube-local-likes", liked.filter(id => id !== video.id)); state.liked = false;
    } else {
      liked.push(video.id); writeList("youtube-local-likes", liked); state.liked = true;
    }
    const raw = await getLocalVideoRaw(video.id);
    if (raw) {
      raw.likesCount = Math.max(0, Number(raw.likesCount || 0) + (state.liked ? 1 : -1));
      await saveLocalVideo(raw); video.likesCount = raw.likesCount;
    }
  }
  renderMain();
}
async function toggleSubscribe() {
  const video = state.watching;
  if (!video || !video.user_id) return;
  if (state.backend) {
    if (!state.user) { openAuthModal("signin"); toast("Sign in to subscribe."); return; }
    if (video.user_id === state.user.id) return;
    if (state.subscribed) {
      const { error } = await state.supabase.from("subscriptions").delete().eq("subscriber_id", state.user.id).eq("channel_id", video.user_id);
      if (error) { toast(error.message); return; }
      state.subscribed = false;
    } else {
      const { error } = await state.supabase.from("subscriptions").insert({ subscriber_id: state.user.id, channel_id: video.user_id });
      if (error) { toast(error.message); return; }
      state.subscribed = true;
    }
  } else {
    const subs = readList("youtube-local-subs");
    if (subs.includes(video.user_id)) { writeList("youtube-local-subs", subs.filter(id => id !== video.user_id)); state.subscribed = false; }
    else { subs.push(video.user_id); writeList("youtube-local-subs", subs); state.subscribed = true; }
  }
  renderMain();
}
async function postComment(form) {
  const input = $('input[name="comment"]', form);
  const body = String(input.value || "").trim();
  if (!body || !state.watching) return;
  const author = state.profile?.username || (state.user?.email ? state.user.email.split("@")[0] : "You");
  if (state.backend) {
    if (!state.user) { openAuthModal("signin"); toast("Sign in to comment."); return; }
    const { error } = await state.supabase.from("comments").insert({ video_id: state.watching.id, user_id: state.user.id, body });
    if (error) { toast(error.message); return; }
    const { data } = await state.supabase.from("comments").select("*, profiles(username, avatar_url)").eq("video_id", state.watching.id).order("created_at", { ascending: false }).limit(100);
    state.comments = (data || []).map(c => ({ ...c, author: c.profiles?.username || "Creator" }));
  } else {
    state.comments.unshift({ id: uniqueId(), author, body, createdAt: new Date().toISOString() });
    localStorage.setItem("youtube-comments-" + state.watching.id, JSON.stringify(state.comments));
  }
  renderMain(); toast("Comment added.");
}
function toggleWatchLater() {
  if (!state.watching) return;
  const ids = readList("youtube-watch-later");
  if (ids.includes(state.watching.id)) { writeList("youtube-watch-later", ids.filter(id => id !== state.watching.id)); toast("Removed from Watch later."); }
  else { ids.unshift(state.watching.id); writeList("youtube-watch-later", ids); toast("Saved to Watch later."); }
}
async function shareVideo() {
  if (!state.watching) return;
  const url = location.origin + location.pathname + "#watch/" + encodeURIComponent(state.watching.id);
  try {
    if (navigator.share) await navigator.share({ title: state.watching.title, url });
    else { await navigator.clipboard.writeText(url); toast("Video link copied."); }
  } catch (error) { if (error.name !== "AbortError") toast("Could not share this link."); }
}
function showVideoMenu(id) {
  const video = id ? state.videos.find(v => v.id === id) : state.watching;
  if (!video) return;
  modalRoot.innerHTML = '<div class="modal-backdrop" data-action="close-modal"><section class="modal" data-modal-content><div class="modal-head"><h2>Video options</h2><button class="modal-close" data-action="close-modal">×</button></div>' +
    '<button class="nav-item" data-action="save-video" data-id="' + attr(video.id) + '"><span class="nav-icon">◷</span><span>Save to Watch later</span></button>' +
    '<button class="nav-item" data-action="share-video" data-id="' + attr(video.id) + '"><span class="nav-icon">↗</span><span>Share</span></button>' +
    (state.user && video.user_id === state.user.id ? '<button class="nav-item" data-action="delete-video" data-id="' + attr(video.id) + '"><span class="nav-icon">⌫</span><span>Delete video</span></button>' : '') +
    '</section></div>';
}
async function deleteVideo(id) {
  const video = state.videos.find(v => v.id === id);
  if (!video || !confirm("Delete this video? This cannot be undone.")) return;
  if (state.backend) {
    const { error } = await state.supabase.from("videos").delete().eq("id", id).eq("user_id", state.user.id);
    if (error) { toast(error.message); return; }
    if (video.storage_path) await state.supabase.storage.from("videos").remove([video.storage_path]);
    if (video.thumbnail_path) await state.supabase.storage.from("thumbnails").remove([video.thumbnail_path]);
  } else await localDBRequest("readwrite", "delete", id);
  closeModal(); await loadVideos();
  if (state.watching?.id === id) setPage("home"); else renderMain();
  toast("Video deleted.");
}
function showSettings() {
  modalRoot.innerHTML = '<div class="modal-backdrop" data-action="close-modal"><section class="modal" data-modal-content><div class="modal-head"><h2>Settings</h2><button class="modal-close" data-action="close-modal">×</button></div>' +
    '<div class="field"><label>Appearance</label><button class="secondary-btn" data-action="theme">' + (document.documentElement.dataset.theme === "dark" ? "Switch to light theme" : "Switch to dark theme") + '</button></div>' +
    '<div class="field"><label>Platform mode</label><p class="field-help">' + (state.backend ? "Connected to Supabase. Accounts and public uploads are enabled." : "Local demo mode. Videos are stored on this device only.") + '</p></div>' +
    (state.user && state.backend ? '<div class="modal-actions"><button class="secondary-btn" data-action="sign-out">Sign out</button></div>' : '') +
    '</section></div>';
}
async function handleClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action, id = target.dataset.id;
  if (action === "close-modal") { if (target === event.target || !target.closest("[data-modal-content]")) closeModal(); return; }
  if (action === "toggle-sidebar") { state.sidebarCollapsed = !state.sidebarCollapsed; document.body.classList.toggle("sidebar-collapsed", state.sidebarCollapsed); renderSidebar(); return; }
  if (action === "go-home") { setPage("home"); return; }
  if (action === "go-shorts") { setPage("shorts"); return; }
  if (action === "go-subscriptions") { setPage("subscriptions"); return; }
  if (action === "go-profile") { setPage("profile"); return; }
  if (action === "go-history") { setPage("history"); return; }
  if (action === "go-watch-later") { setPage("watch-later"); return; }
  if (action === "show-upload") { openUploadModal(); return; }
  if (action === "sign-in") { openAuthModal("signin"); return; }
  if (action === "auth-mode") { state.authMode = target.dataset.mode; renderAuthModal(); return; }
  if (action === "theme") { setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); renderHeader(); if (modalRoot.innerHTML) showSettings(); return; }
  if (action === "settings") { showSettings(); return; }
  if (action === "notifications") { toast("You have no new notifications."); return; }
  if (action === "account") { showSettings(); return; }
  if (action === "category") { state.selectedCategory = target.dataset.category; renderMain(); return; }
  if (action === "clear-search") { state.search = ""; const input = $("#search-input"); if (input) input.value = ""; renderMain(); return; }
  if (action === "search") { const input = $("#search-input"); state.search = input ? input.value : state.search; state.page = "home"; renderSidebar(); renderMain(); return; }
  if (action === "open-video") { openVideo(id); return; }
  if (action === "open-channel") { openChannel(id); return; }
  if (action === "like") { await toggleLike(); return; }
  if (action === "subscribe") { await toggleSubscribe(); return; }
  if (action === "share") { await shareVideo(); return; }
  if (action === "watch-later-toggle") { toggleWatchLater(); return; }
  if (action === "video-menu") { showVideoMenu(id); return; }
  if (action === "save-video") {
    const ids = readList("youtube-watch-later");
    if (!ids.includes(id)) ids.unshift(id);
    writeList("youtube-watch-later", ids); closeModal(); toast("Saved to Watch later."); return;
  }
  if (action === "share-video") {
    const video = state.videos.find(v => v.id === id);
    closeModal();
    if (video) {
      const url = location.origin + location.pathname + "#watch/" + encodeURIComponent(video.id);
      try { await navigator.clipboard.writeText(url); toast("Video link copied."); } catch { toast(url); }
    }
    return;
  }
  if (action === "delete-video") { await deleteVideo(id); return; }
  if (action === "voice-search") { toast("Voice search is not available in this version."); return; }
  if (action === "sign-out") {
    await state.supabase.auth.signOut(); state.user = null; state.profile = null; closeModal();
    renderShell(); renderMain(); toast("Signed out.");
  }
}
document.body.addEventListener("click", handleClick);
document.addEventListener("submit", async event => {
  if (event.target.id === "upload-form") { event.preventDefault(); await publishVideo(new FormData(event.target)); }
  else if (event.target.id === "auth-form") { event.preventDefault(); await handleAuth(event.target); }
  else if (event.target.id === "comment-form") { event.preventDefault(); await postComment(event.target); }
});
document.addEventListener("input", event => {
  if (event.target.id === "search-input") { state.search = event.target.value; state.page = "home"; renderMain(); }
});
document.addEventListener("change", event => {
  if (event.target.id === "video-file") {
    const file = event.target.files && event.target.files[0];
    state.uploadFile = file || null;
    $("#video-file-label").textContent = file ? file.name + " · " + (file.size / 1048576).toFixed(1) + " MB" : "MP4, WebM or MOV · maximum 50 MB";
    if (file && !$("#video-title").value) $("#video-title").value = file.name.replace(/\.[^.]+$/, "").replace(/[_-]/g, " ");
  }
  if (event.target.id === "thumbnail-file") {
    state.thumbnailFile = event.target.files && event.target.files[0] || null;
    const preview = $("#thumbnail-preview");
    if (preview && state.thumbnailFile) { preview.src = URL.createObjectURL(state.thumbnailFile); preview.hidden = false; }
    else if (preview) preview.hidden = true;
  }
});
window.addEventListener("hashchange", parseRoute);
window.addEventListener("popstate", parseRoute);

async function initialise() {
  setTheme();
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch(error => console.warn("Service worker registration failed:", error));
  }
  const config = window.APP_CONFIG || {};
  if (config.supabaseUrl && config.supabaseAnonKey) {
    try {
      state.supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      state.backend = true;
      const { data } = await state.supabase.auth.getSession();
      state.user = data.session?.user || null;
      await loadProfile();
      state.supabase.auth.onAuthStateChange(async (_event, session) => {
        state.user = session?.user || null;
        await loadProfile(); renderShell(); renderMain();
      });
    } catch (error) {
      console.error("Supabase setup failed:", error);
      state.supabase = null; state.backend = false; state.user = getLocalUser();
      toast("Backend could not connect. Running in local demo mode.");
    }
  } else state.user = getLocalUser();
  try { await loadVideos(); }
  catch (error) { console.error("Could not load the video feed:", error); state.videos = []; toast("Could not load the feed. Check the Supabase setup."); }
  renderShell();
  if (location.hash) parseRoute(); else renderMain();
}
initialise();
