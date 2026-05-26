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
const timeLabel = (date) => new Intl.DateTimeFormat("en-US", { timeZone: HOME_TZ, hour: "numeric", minute: "2-digit" }).format(date);
const dayName = (date) => new Intl.DateTimeFormat("en-US", { timeZone: HOME_TZ, weekday: "long", month: "short", day: "numeric" }).format(date);
const addDays = (date, days) => new Date(date.getTime() + days * 86400000);
const normalizeCalendarUrl = (url) => {
  const value = String(url || "").trim();
  return value.startsWith("webcal://") ? `https://${value.slice("webcal://".length)}` : value;
};
async function authorized(request) {
  const url = new URL(request.url);
  const res = await fetch(`${url.origin}/api/status`, { headers: { cookie: request.headers.get("cookie") || "" } });
  if (!res.ok) return false;
  const status = await res.json();
  return ["admin", "viewer"].includes(status?.session?.role);
}
function eventRecord(ev, dt, bucket, nowMs) {
  const js = dt.toJSDate();
  const allDay = Boolean(ev.startDate?.isDate);
  const sort = allDay ? new Date(`${fmtDate(js)}T00:00:00`).getTime() : js.getTime();
  return {
    title: clean(ev.summary || "Calendar event"),
    time: allDay ? "All day" : timeLabel(js),
    sort,
    passed: bucket === "today" && !allDay && sort < nowMs
  };
}
async function readEvents() {
  const url = normalizeCalendarUrl(env("ICAL_FEED_URL"));
  if (!url) return { today: [], tomorrow: [], warning: "No shared iCal URL configured yet." };
  const now = new Date();
  const today = fmtDate(now);
  const tomorrowDate = addDays(now, 1);
  const tomorrow = fmtDate(tomorrowDate);
  const res = await fetch(url, { headers: { "user-agent": "wheres-trevor-home-app" } });
  if (!res.ok) throw new Error(`iCal fetch failed: ${res.status}`);
  const comp = new ICAL.Component(ICAL.parse(await res.text()));
  const todayEvents = [];
  const tomorrowEvents = [];
  const add = (ev, dt) => {
    const localDate = fmtDate(dt.toJSDate());
    if (localDate === today) todayEvents.push(eventRecord(ev, dt, "today", now.getTime()));
    if (localDate === tomorrow) tomorrowEvents.push(eventRecord(ev, dt, "tomorrow", now.getTime()));
  };
  for (const item of comp.getAllSubcomponents("vevent")) {
    const ev = new ICAL.Event(item);
    if (ev.isRecurring()) {
      const iter = ev.iterator();
      let next;
      let count = 0;
      while ((next = iter.next()) && count < 1200) {
        count += 1;
        const localDate = fmtDate(next.toJSDate());
        if (localDate > tomorrow) break;
        if (localDate === today || localDate === tomorrow) add(ev, next);
      }
    } else {
      add(ev, ev.startDate);
    }
  }
  const byTime = (a, b) => a.sort - b.sort;
  return {
    todayLabel: "Today",
    tomorrowLabel: `Tomorrow — ${dayName(tomorrowDate)}`,
    today: todayEvents.sort(byTime),
    tomorrow: tomorrowEvents.sort(byTime)
  };
}
export default async (request) => {
  try {
    if (!(await authorized(request))) return json({ error: "Login required." }, 401);
    return json(await readEvents());
  } catch (error) {
    return json({ today: [], tomorrow: [], error: error.message || "Calendar unavailable." }, 200);
  }
};
export const config = { path: "/calendar-bridge" };
