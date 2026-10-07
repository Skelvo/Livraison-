// Alertes départ : notification sur les téléphones abonnés 5 min avant chaque départ.
//
// Appelée chaque minute par une tâche pg_cron (action "tick", protégée par x-cron-secret),
// et par l'app juste après l'abonnement d'un téléphone (action "welcome") pour confirmer
// que les alertes arrivent bien.
//
// Les horaires viennent de data.js (ou index.html avant la séparation) sur la branche main
// du dépôt : modifier un horaire dans l'app suffit, rien à changer ici.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const MINUTES_BEFORE = 5;
const SOURCES = [
  "https://raw.githubusercontent.com/Skelvo/Livraison-/main/data.js",
  "https://raw.githubusercontent.com/Skelvo/Livraison-/main/index.html",
];

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Schedule = { carriers: Record<string, { label: string }>; deps: Record<string, string[]> };
let cache: { at: number; schedule: Schedule } | null = null;

function extractObject(src: string, name: string): string | null {
  const m = src.match(new RegExp("const\\s+" + name + "\\s*=\\s*(\\{[\\s\\S]*?\\n\\});"));
  return m ? m[1] : null;
}

// Les horaires sont relus au plus toutes les 10 minutes
async function loadSchedule(): Promise<Schedule> {
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.schedule;
  for (const url of SOURCES) {
    const res = await fetch(url);
    if (!res.ok) continue;
    const src = await res.text();
    const carriers = extractObject(src, "CARRIERS");
    const deps = extractObject(src, "CARRIER_DEPS");
    if (!carriers || !deps) continue;
    const schedule = {
      carriers: new Function("return " + carriers)(),
      deps: new Function("return " + deps)(),
    } as Schedule;
    cache = { at: Date.now(), schedule };
    return schedule;
  }
  if (cache) return cache.schedule;
  throw new Error("Horaires introuvables");
}

async function config() {
  const { data, error } = await db.from("push_config").select("name,value");
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((r) => [r.name, r.value])) as Record<string, string>;
}

// Heure de Paris, quel que soit le fuseau du serveur
function parisNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday as string,
    minutes: (parseInt(parts.hour) % 24) * 60 + parseInt(parts.minute),
  };
}

// Jours fériés en France (date au format AAAA-MM-JJ)
function holidays(year: number): Set<string> {
  // Dimanche de Pâques (algorithme de Meeus)
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  const easter = Date.UTC(year, month - 1, day);
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const plus = (n: number) => iso(easter + n * 864e5);
  return new Set([
    `${year}-01-01`, `${year}-05-01`, `${year}-05-08`, `${year}-07-14`,
    `${year}-08-15`, `${year}-11-01`, `${year}-11-11`, `${year}-12-25`,
    plus(1),  // lundi de Pâques
    plus(39), // Ascension
    plus(50), // lundi de Pentecôte
  ]);
}

const parseTime = (s: string) => {
  const [h, m] = s.split("h");
  return parseInt(h) * 60 + parseInt(m || "0");
};

type Sub = { endpoint: string; p256dh: string; auth: string };

async function sendToAll(subs: Sub[], payload: object) {
  const body = JSON.stringify(payload);
  let ok = 0;
  const gone: string[] = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { TTL: 300, urgency: "high" },
      );
      ok++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      const reason = String((e as { body?: string }).body ?? (e as Error).message);
      // Téléphone désabonné, app supprimée ou abonnement invalide : on l'oublie
      if (code === 404 || code === 410 || (code === 400 && /BadWebPushToken|BadDeviceToken/.test(reason))) {
        gone.push(s.endpoint);
      } else console.log("push error", code, reason);
    }
  }));
  if (gone.length) await db.from("push_subscriptions").delete().in("endpoint", gone);
  return { sent: ok, removed: gone.length, failed: subs.length - ok - gone.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const cfg = await config();
    webpush.setVapidDetails("https://github.com/Skelvo/Livraison-", cfg.vapid_public, cfg.vapid_private);

    // Confirmation envoyée au téléphone qui vient de s'abonner
    if (body.action === "welcome") {
      const { data } = await db.from("push_subscriptions")
        .select("endpoint,p256dh,auth").eq("endpoint", String(body.endpoint ?? "")).limit(1);
      if (!data?.length) return json({ error: "abonnement inconnu" }, 404);
      const r = await sendToAll(data, {
        title: "🔔 Alertes départ activées",
        body: `Tu seras prévenu ${MINUTES_BEFORE} min avant chaque départ.`,
        tag: "welcome",
      });
      return json(r);
    }

    if (body.action === "tick") {
      if (req.headers.get("x-cron-secret") !== cfg.cron_secret) return json({ error: "interdit" }, 403);
      const now = parisNow();
      if (now.weekday === "Sun") return json({ skipped: "dimanche" });
      if (holidays(parseInt(now.date)).has(now.date)) return json({ skipped: "jour férié" });

      const schedule = await loadSchedule();
      // "at" (ex. "11h10") permet de tester un horaire précis
      const target = (body.at ? parseTime(String(body.at)) : now.minutes) + MINUTES_BEFORE;
      const leaving = Object.keys(schedule.deps).filter((cid) =>
        schedule.deps[cid].some((t) => parseTime(t) === target)
      );
      if (!leaving.length) return json({ nothing: true });

      const time = schedule.deps[leaving[0]].find((t) => parseTime(t) === target)!;
      // Une seule alerte par horaire et par jour, même si la tâche tourne deux fois
      const { error: dup } = await db.from("push_sent").insert({ key: `${now.date}|${time}` });
      if (dup) return json({ already: true });

      const labels = leaving.map((cid) => schedule.carriers[cid]?.label ?? cid);
      const { data: subs } = await db.from("push_subscriptions").select("endpoint,p256dh,auth");
      const r = await sendToAll(subs ?? [], {
        title: `⏰ Départ dans ${MINUTES_BEFORE} min — ${time}`,
        body: labels.join(" · "),
        tag: `dep-${time}`,
      });
      // Ménage : on ne garde que quelques jours d'historique
      await db.from("push_sent").delete().lt("sent_at", new Date(Date.now() - 7 * 864e5).toISOString());
      return json({ time, carriers: labels, ...r });
    }

    return json({ error: "action inconnue" }, 400);
  } catch (e) {
    console.log("error", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
