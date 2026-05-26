import ICAL from "ical.js";

const HOME_TZ = "America/Los_Angeles";
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive"
  }
});
const clean = (value, max = 140) => String(value || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const env = (name) => process.env[name] || (globalThis.Netlify?.env?.get ? Netlify.env.get(name) : undefined);
const fmtDate = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: HOME_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const todayISO = () => fmtDate(new Date());
const timeLabel = (date) => new Intl.DateTimeFormat("en-US", { timeZone: HOME_TZ, hour: "numeric", minute: "2-digit" }).format(date);
const normalizeCalendarUrl = (url) => {
  const value = String(url || "").trim();
  return value.startsWith("webcal://") ? `https://${value.slice("webcal://".length)}` : value;
};
async function authorized(request) {
  const url = new URL(request.url);
  const statusUrl = `${url.origin}/api/status`;
  const res = await fetch(statusUrl, { headers: { cookie: request.headers.get("cookie") || "" } });
  if (!res.ok) return false;
  const status = await res.json();
  return ["admin", "viewer"].includes(status?.session?.role);
}
async function readTodayEvents() {
  const url = normalizeCalendarUrl(env("ICAL_FEED_URL"));
  if (!url) return { events: [], warning: "No shared iCal URL configured yet." };
  const today = todayISO();
  const res = await fetch(url, { headers: { "user-agent": "wheres-trevor-home-app" } });
  if (!res.ok) throw new Error(`iCal fetch failed: ${res.status}`);
  const comp = new ICAL.Component(ICAL.parse(await res.text()));
  const events = [];
  const maybeAdd = (ev, dt) => {
    const js = dt.toJSDate();
    if (fmtDate(js) === today) events.push({ title: clean(ev.summary || "Calendar event"), time: ev.startDate.isDate ? "All day" : timeLabel(js) });
  };
  for (const item of comp.getAllSubcomponents("vevent")) {
    const ev = new ICAL.Event(item);
    if (ev.isRecurring()) {
      const iter = ev.iterator();
      let next;
      let count = 0;
      while ((next = iter.next()) && count < 900) {
        count += 1;
        const date = fmtDate(next.toJSDate());
        if (date > today) break;
        if (date === today) maybeAdd(ev, next);
      }
    } else {
      maybeAdd(ev, ev.startDate);
    }
  }
  return { events: events.sort((a, b) => a.time.localeCompare(b.time)).slice(0, 12) };
}
export default async (request) => {
  try {
    if (!(await authorized(request))) return json({ error: "Login required." }, 401);
    return json(await readTodayEvents());
  } catch (error) {
    return json({ events: [], error: error.message || "Calendar unavailable." }, 200);
  }
};
export const config = { path: "/calendar-bridge" };
