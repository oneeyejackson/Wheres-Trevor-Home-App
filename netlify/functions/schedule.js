import { createHmac, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

const AUTH_STORE = "wt-auth";
const SCHEDULE_STORE = "wt-schedule";
const SESSION_COOKIE = "wt_session";

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive"
  }
});
const authStore = () => getStore(AUTH_STORE, { consistency: "strong" });
const scheduleStore = () => getStore(SCHEDULE_STORE, { consistency: "strong" });
function safeEqual(a = "", b = "") {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && timingSafeEqual(A, B);
}
function parseCookies(request) {
  return Object.fromEntries((request.headers.get("cookie") || "").split(";").map(c => c.trim()).filter(Boolean).map(c => {
    const [n, ...r] = c.split("=");
    return [n, decodeURIComponent(r.join("="))];
  }));
}
function hmac(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}
async function session(request) {
  const settings = await authStore().get("settings", { type: "json" });
  const secret = settings?.sessionSecret;
  if (!secret) return null;
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token || !token.includes(".")) return null;
  const [encoded, sig] = token.split(".");
  if (!safeEqual(sig, hmac(encoded, secret))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!["admin", "viewer"].includes(payload.role)) return null;
    return payload;
  } catch {
    return null;
  }
}
function cleanText(value, max = 220) {
  return String(value || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}
function cleanNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function cleanStop(raw) {
  const type = ["show", "travel", "off", "home", "rehearsal", "unknown"].includes(raw?.type) ? raw.type : "unknown";
  return {
    date: cleanText(raw?.date, 10),
    type,
    city: cleanText(raw?.city || "Travel day", 80),
    region: cleanText(raw?.region, 80),
    timezone: cleanText(raw?.timezone || "America/Los_Angeles", 80),
    subtitle: cleanText(raw?.subtitle, 100),
    note: cleanText(raw?.note, 220),
    cityFact: cleanText(raw?.cityFact, 280),
    coffee: Array.isArray(raw?.coffee) ? raw.coffee.slice(0, 4).map(c => ({ name: cleanText(c?.name, 90), note: cleanText(c?.note, 180) })).filter(c => c.name) : [],
    thingsToDo: Array.isArray(raw?.thingsToDo) ? raw.thingsToDo.slice(0, 3).map(t => ({ title: cleanText(t?.title, 90), note: cleanText(t?.note, 180) })).filter(t => t.title) : [],
    latitude: cleanNum(raw?.latitude),
    longitude: cleanNum(raw?.longitude),
    photoPrompt: cleanText(raw?.photoPrompt, 220)
  };
}
function validStop(stop) {
  return /^\d{4}-\d{2}-\d{2}$/.test(stop.date) && Boolean(stop.city);
}
async function readSchedule() {
  const saved = await scheduleStore().get("schedule", { type: "json" });
  return Array.isArray(saved) ? saved.filter(validStop).sort((a, b) => a.date.localeCompare(b.date)) : [];
}
async function weatherFor(stop) {
  if (stop.latitude == null || stop.longitude == null) return null;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(stop.latitude)}&longitude=${encodeURIComponent(stop.longitude)}&current=temperature_2m,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=1`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const d = await r.json();
  return {
    temperature: Math.round(d?.current?.temperature_2m ?? 0),
    wind: Math.round(d?.current?.wind_speed_10m ?? 0),
    high: Math.round(d?.daily?.temperature_2m_max?.[0] ?? 0),
    low: Math.round(d?.daily?.temperature_2m_min?.[0] ?? 0),
    precip: d?.daily?.precipitation_probability_max?.[0]
  };
}

export default async (request) => {
  const user = await session(request);
  if (!user) return json({ error: "Login required." }, 401);
  if (request.method === "GET") {
    const schedule = await readSchedule();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const todayStop = schedule.find(s => s.date === today) || null;
    return json({ role: user.role, schedule, todayStop, todayWeather: todayStop ? await weatherFor(todayStop) : null });
  }
  if (request.method === "POST") {
    if (user.role !== "admin") return json({ error: "Admin required." }, 403);
    const input = await request.json();
    const rows = Array.isArray(input) ? input : input.schedule;
    if (!Array.isArray(rows)) return json({ error: "JSON must contain a schedule array." }, 400);
    const schedule = rows.map(cleanStop).filter(validStop).sort((a, b) => a.date.localeCompare(b.date));
    if (!schedule.length) return json({ error: "No valid schedule rows found." }, 400);
    await scheduleStore().setJSON("schedule", schedule);
    return json({ ok: true, count: schedule.length });
  }
  return json({ error: "Method not allowed." }, 405);
};

export const config = { path: "/.netlify/functions/schedule" };
