import { createHmac, randomBytes, scryptSync, timingSafeEqual, randomUUID } from "node:crypto";
import { getStore } from "@netlify/blobs";
import ICAL from "ical.js";

const SESSION_COOKIE = "wt_session";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const HOME_TZ = "America/Los_Angeles";
const AUTH_STORE = "wt-auth";
const DAYSHEET_STORE = "wt-daysheets";

function env(name) { return process.env[name] || (globalThis.Netlify?.env?.get ? Netlify.env.get(name) : undefined); }
function authStore() { return getStore(AUTH_STORE, { consistency: "strong" }); }
function daysheetStore() { return getStore(DAYSHEET_STORE, { consistency: "strong" }); }
function nowSeconds() { return Math.floor(Date.now() / 1000); }
function todayISO() { return new Intl.DateTimeFormat("en-CA", { timeZone: HOME_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function base64url(value) { return Buffer.from(value).toString("base64url"); }
function json(body, status = 200, extra = {}) { return new Response(JSON.stringify(body), { status, headers: securityHeaders({ "content-type": "application/json; charset=utf-8", ...extra }) }); }
function securityHeaders(extra = {}) { return { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow, noarchive", ...extra }; }
function safeEqual(a = "", b = "") { const A = Buffer.from(String(a)); const B = Buffer.from(String(b)); if (A.length !== B.length) return false; return timingSafeEqual(A, B); }
function secret(name) { const v = env(name); if (!v || v.length < 24 || v.includes("change-me")) throw new Error(`${name} must be configured and at least 24 characters.`); return v; }
function hmac(value) { return createHmac("sha256", secret("SESSION_SECRET")).update(value).digest("base64url"); }
function isHttps(request) { return new URL(request.url).protocol === "https:"; }
function parseCookies(request) { return Object.fromEntries((request.headers.get("cookie") || "").split(";").map(c => c.trim()).filter(Boolean).map(c => { const [n, ...r] = c.split("="); return [n, decodeURIComponent(r.join("="))]; })); }
function cleanUsername(v) { return String(v || "").trim().toLowerCase(); }
function passwordRecord(password) { const salt = randomBytes(16).toString("base64url"); const hash = scryptSync(String(password), salt, 64).toString("base64url"); return { alg: "scrypt", salt, hash }; }
function verifyPassword(password, record) { if (!record?.salt || !record?.hash) return false; const hash = scryptSync(String(password), record.salt, 64).toString("base64url"); return safeEqual(hash, record.hash); }
function makeCookie(request, user) { const payload = { username: user.username, role: user.role, csrf: randomUUID(), iat: nowSeconds(), exp: nowSeconds() + SESSION_SECONDS }; const encoded = base64url(JSON.stringify(payload)); const signed = `${encoded}.${hmac(encoded)}`; const attrs = [`${SESSION_COOKIE}=${encodeURIComponent(signed)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${SESSION_SECONDS}`]; if (isHttps(request)) attrs.push("Secure"); return { payload, cookie: attrs.join("; ") }; }
function clearCookie(request) { const attrs = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"]; if (isHttps(request)) attrs.push("Secure"); return attrs.join("; "); }
function readSession(request) { const token = parseCookies(request)[SESSION_COOKIE]; if (!token || !token.includes(".")) return null; const [encoded, sig] = token.split("."); if (!safeEqual(sig, hmac(encoded))) return null; try { const p = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); if (!p.exp || p.exp < nowSeconds()) return null; if (!p.username || !["admin", "viewer", "guest"].includes(p.role)) return null; return p; } catch { return null; } }
async function loadSettings() { return (await authStore().get("settings", { type: "json" })) || null; }
async function saveSettings(settings) { await authStore().setJSON("settings", settings); }
function requirePrivate(request) { const s = readSession(request); if (!s) return { response: json({ error: "Login required." }, 401), session: null }; if (!["admin", "viewer"].includes(s.role)) return { response: json({ error: "Private dashboard login required." }, 403), session: null }; return { response: null, session: s }; }
function requireAdmin(request) { const s = readSession(request); if (!s) return { response: json({ error: "Login required." }, 401), session: null }; if (s.role !== "admin") return { response: json({ error: "Admin login required." }, 403), session: null }; return { response: null, session: s }; }
function requireCsrf(request, session) { const token = request.headers.get("x-wt-csrf") || ""; if (!session?.csrf || !safeEqual(token, session.csrf)) return json({ error: "Security check failed. Refresh and try again." }, 403); return null; }

function getTourSchedule() {
  const raw = env("TOUR_SCHEDULE_JSON");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((x) => ({
      date: String(x.date || "").slice(0, 10),
      city: String(x.city || "Travel day").slice(0, 80),
      region: String(x.region || "").slice(0, 80),
      timezone: String(x.timezone || HOME_TZ).slice(0, 80),
      type: ["show", "travel", "off", "home", "rehearsal", "unknown"].includes(x.type) ? x.type : "unknown",
      note: String(x.note || "").slice(0, 220),
      cityFact: String(x.cityFact || "").slice(0, 220),
      photoPrompt: String(x.photoPrompt || "").slice(0, 220)
    })).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.date)).sort((a,b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

function normalizeCalendarUrl(url) {
  const v = String(url || "").trim();
  if (!v) return "";
  if (v.startsWith("webcal://")) return `https://${v.slice("webcal://".length)}`;
  return v;
}
function timeLabel(date) { return new Intl.DateTimeFormat("en-US", { timeZone: HOME_TZ, hour: "numeric", minute: "2-digit" }).format(date); }
async function sharedCalendarEvents() {
  const url = normalizeCalendarUrl(env("ICAL_FEED_URL"));
  if (!url) return { events: [], warning: "No shared iCal URL configured yet." };
  const today = todayISO();
  const start = new Date(`${today}T00:00:00-07:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const res = await fetch(url, { headers: { "user-agent": "wheres-trevor-home-app" } });
  if (!res.ok) throw new Error(`iCal fetch failed: ${res.status}`);
  const ics = await res.text();
  const comp = new ICAL.Component(ICAL.parse(ics));
  const vevents = comp.getAllSubcomponents("vevent");
  const events = [];
  for (const v of vevents) {
    const ev = new ICAL.Event(v);
    const pushEvent = (dt) => {
      const js = dt.toJSDate();
      if (js >= start && js < end) events.push({ title: String(ev.summary || "Calendar event").slice(0, 120), time: ev.startDate.isDate ? "All day" : timeLabel(js) });
    };
    if (ev.isRecurring()) {
      const iter = ev.iterator();
      let next; let count = 0;
      while ((next = iter.next()) && count < 500) { count += 1; const js = next.toJSDate(); if (js >= end) break; if (js >= start) pushEvent(next); }
    } else {
      pushEvent(ev.startDate);
    }
  }
  return { events: events.sort((a,b) => a.time.localeCompare(b.time)).slice(0, 12) };
}
async function weather() {
  const settings = await loadSettings();
  const w = settings?.weather || { label: "Altadena, CA", latitude: 34.1897, longitude: -118.1312 };
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(w.latitude)}&longitude=${encodeURIComponent(w.longitude)}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=${encodeURIComponent(HOME_TZ)}`;
  const res = await fetch(url);
  if (!res.ok) return { label: w.label, error: "Weather unavailable" };
  const data = await res.json();
  return { label: w.label, temperature: Math.round(data?.current?.temperature_2m), humidity: data?.current?.relative_humidity_2m, wind: Math.round(data?.current?.wind_speed_10m || 0), code: data?.current?.weather_code };
}

async function handleStatus(request) { const settings = await loadSettings(); const session = readSession(request); return json({ setupComplete: Boolean(settings?.users?.length), session: session ? { username: session.username, role: session.role, csrf: session.csrf } : null }); }
async function handleSetup(request) {
  const existing = await loadSettings(); if (existing?.users?.length) return json({ error: "Setup has already been completed." }, 409);
  const input = await request.json(); if (!safeEqual(String(input.setupCode || ""), secret("SETUP_CODE"))) return json({ error: "Incorrect setup code." }, 403);
  const adminUsername = cleanUsername(input.adminUsername); const viewerUsername = cleanUsername(input.viewerUsername); const guestUsername = cleanUsername(input.guestUsername || "guest");
  const names = [adminUsername, viewerUsername, guestUsername]; if (names.some(n => n.length < 3) || new Set(names).size !== names.length) return json({ error: "Use three unique usernames, at least 3 characters each." }, 400);
  if ([input.adminPassword, input.viewerPassword, input.guestPassword].some(p => String(p || "").length < 12)) return json({ error: "All passwords must be at least 12 characters." }, 400);
  const pin = String(input.guestExitPin || "").trim(); if (!/^\d{4,8}$/.test(pin)) return json({ error: "Guest exit PIN must be 4-8 numbers." }, 400);
  const weatherSettings = { label: String(input.weatherLabel || "Altadena, CA").slice(0,80), latitude: Number(input.weatherLatitude) || 34.1897, longitude: Number(input.weatherLongitude) || -118.1312 };
  await saveSettings({ version: 1, createdAt: new Date().toISOString(), weather: weatherSettings, guestExitPin: passwordRecord(pin), users: [
    { username: adminUsername, displayName: "Trevor", role: "admin", password: passwordRecord(input.adminPassword) },
    { username: viewerUsername, displayName: "Andrea", role: "viewer", password: passwordRecord(input.viewerPassword) },
    { username: guestUsername, displayName: "Guest", role: "guest", password: passwordRecord(input.guestPassword) }
  ]});
  return json({ ok: true });
}
async function handleLogin(request) { const { username, password } = await request.json(); const settings = await loadSettings(); if (!settings?.users?.length) return json({ error: "Setup required.", setupRequired: true }, 409); const user = settings.users.find(u => u.username === cleanUsername(username)); if (!user || !verifyPassword(password, user.password)) return json({ error: "Incorrect username or password." }, 401); const { payload, cookie } = makeCookie(request, user); return json({ ok: true, session: { username: payload.username, role: payload.role, csrf: payload.csrf } }, 200, { "set-cookie": cookie }); }
async function handleLogout(request) { return json({ ok: true }, 200, { "set-cookie": clearCookie(request) }); }
async function handleGuestPin(request) { const { pin } = await request.json(); const settings = await loadSettings(); const ok = verifyPassword(String(pin || ""), settings?.guestExitPin); return json({ ok }); }
async function handleDashboard(request) { const auth = requirePrivate(request); if (auth.response) return auth.response; const today = todayISO(); const schedule = getTourSchedule(); const todayStop = schedule.find(x => x.date === today) || null; const nextStops = schedule.filter(x => x.date >= today).slice(0,5); const store = daysheetStore(); const index = (await store.get("index", { type: "json" })) || []; const daysheets = index.filter(s => s.date >= today).sort((a,b) => a.date.localeCompare(b.date)).map(({date,key,filename,mimeType,uploadedAt}) => ({date,key,filename,mimeType,uploadedAt})); let shared = { events: [] }; try { shared = await sharedCalendarEvents(); } catch (e) { shared = { events: [], error: e.message }; } return json({ today, role: auth.session.role, username: auth.session.username, homeTimeZone: HOME_TZ, todayStop, nextStops, sharedEvents: shared.events || [], calendarWarning: shared.warning || null, calendarError: shared.error || null, daysheets }); }
async function handleGuest(request) { const session = readSession(request); if (!session || session.role !== "guest") return json({ error: "Guest login required." }, 401); return json({ now: new Date().toISOString(), homeTimeZone: HOME_TZ, weather: await weather() }); }
async function handleUpload(request) { const auth = requireAdmin(request); if (auth.response) return auth.response; const csrf = requireCsrf(request, auth.session); if (csrf) return csrf; const form = await request.formData(); const file = form.get("file"); const date = String(form.get("date") || "").slice(0,10); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Valid date required." }, 400); if (!file || typeof file.arrayBuffer !== "function") return json({ error: "File required." }, 400); if (file.size > 15 * 1024 * 1024) return json({ error: "File must be under 15 MB." }, 400); const filename = String(file.name || "daysheet").replace(/[^a-zA-Z0-9._ -]/g, "").slice(0,120) || "daysheet"; const key = `${date}/${randomUUID()}-${filename}`; await daysheetStore().set(key, await file.arrayBuffer(), { metadata: { filename, mimeType: file.type || "application/octet-stream", date, uploadedAt: new Date().toISOString() } }); const index = (await daysheetStore().get("index", { type: "json" })) || []; index.push({ date, key, filename, mimeType: file.type || "application/octet-stream", uploadedAt: new Date().toISOString() }); await daysheetStore().setJSON("index", index); return json({ ok: true }); }
async function handleDaysheet(request) { const auth = requirePrivate(request); if (auth.response) return auth.response; const url = new URL(request.url); const key = url.searchParams.get("key") || ""; const index = (await daysheetStore().get("index", { type: "json" })) || []; const item = index.find(x => x.key === key); if (!item || item.date < todayISO()) return json({ error: "Daysheet not found." }, 404); const data = await daysheetStore().get(key, { type: "arrayBuffer" }); if (!data) return json({ error: "Daysheet missing." }, 404); return new Response(data, { headers: securityHeaders({ "content-type": item.mimeType || "application/octet-stream", "content-disposition": `inline; filename="${item.filename || "daysheet"}"` }) }); }
async function handleDelete(request) { const auth = requireAdmin(request); if (auth.response) return auth.response; const csrf = requireCsrf(request, auth.session); if (csrf) return csrf; const { key } = await request.json(); const index = (await daysheetStore().get("index", { type: "json" })) || []; const item = index.find(x => x.key === key); if (!item) return json({ error: "Not found." }, 404); await daysheetStore().delete(key); await daysheetStore().setJSON("index", index.filter(x => x.key !== key)); return json({ ok: true }); }

export default async (request) => {
  try {
    const action = new URL(request.url).pathname.replace(/^\/api\/?/, "") || "status";
    if (request.method === "GET" && action === "status") return handleStatus(request);
    if (request.method === "GET" && action === "dashboard") return handleDashboard(request);
    if (request.method === "GET" && action === "guest") return handleGuest(request);
    if (request.method === "GET" && action === "daysheet") return handleDaysheet(request);
    if (request.method === "POST" && action === "setup") return handleSetup(request);
    if (request.method === "POST" && action === "login") return handleLogin(request);
    if (request.method === "POST" && action === "logout") return handleLogout(request);
    if (request.method === "POST" && action === "guest-pin") return handleGuestPin(request);
    if (request.method === "POST" && action === "upload-daysheet") return handleUpload(request);
    if (request.method === "POST" && action === "delete-daysheet") return handleDelete(request);
    return json({ error: "Not found." }, 404);
  } catch (e) {
    return json({ error: e.message || "Unexpected error." }, 500);
  }
};

export const config = { path: "/api/*" };
