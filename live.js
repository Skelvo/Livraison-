// Données « en direct » partagées par index.html et departs.html :
// - transporteurs et horaires modifiés depuis l'admin (table carriers), qui remplacent ceux de data.js
// - retards et annulations du jour (table departure_events)
// - copie locale de tout ça pour fonctionner sans réseau
// À charger juste après data.js.
const LIVE = (function () {
  const URL = 'https://aitbhskkwoqmoqfpogph.supabase.co';
  const KEY = 'sb_publishable_84rSs3LwBpdWs4qbPd5zkA_dOh-ci4s';
  const BUILTIN_PILLS = ['serge', 'lande', 'pb', 'bearn', 'hendaye', 'ace'];

  let renames = {};      // { carrierId: { ancienneHeure: nouvelleHeure } }
  let events = {};       // { 'carrierId|heure': { status, delay } }
  let lastSync = null;   // date de la dernière mise à jour réussie depuis le serveur
  let settings = {};     // réglages de l'admin (table app_settings), ex. prep_minutes
  let health = {};       // surveillance des alertes (table health) : { tick: date, send: {...} }

  function store(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} }
  function load(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }

  async function get(path) {
    const res = await fetch(URL + '/rest/v1/' + path, { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
    if (!res.ok) throw new Error('erreur ' + res.status);
    return res.json();
  }

  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function toMin(s) { const p = s.split('h'); return parseInt(p[0]) * 60 + parseInt(p[1] || 0); }
  function fmt(m) { return String(Math.floor(m / 60)).padStart(2, '0') + 'h' + String(m % 60).padStart(2, '0'); }

  // Suit les renommages en chaîne (A -> B -> C)
  function renamed(cid, time) {
    const map = renames[cid];
    for (let i = 0; map && map[time] && i < 10; i++) time = map[time];
    return time;
  }

  // Met à jour un garage : heures renommées, transporteurs désactivés retirés
  function fixGarage(g) {
    g.carriers = g.carriers.filter(function (c) { return CARRIERS[c.id]; });
    g.carriers.forEach(function (c) {
      c.deps = c.deps.map(function (t) { return renamed(c.id, t); })
        .filter(function (t, i, a) { return a.indexOf(t) === i; });
    });
    return g;
  }

  // Couleurs des transporteurs ajoutés depuis l'admin (les 6 d'origine ont déjà leur style)
  function injectColors(rows) {
    let el = document.getElementById('live-colors');
    if (!el) { el = document.createElement('style'); el.id = 'live-colors'; document.head.appendChild(el); }
    el.textContent = rows.filter(function (r) { return BUILTIN_PILLS.indexOf(r.id) === -1 && /^#[0-9a-f]{6}$/i.test(r.color); })
      .map(function (r) {
        return '.pill-' + r.id + '{background:' + r.color + '26;color:' + r.color + ';border:1px solid ' + r.color + '59;border-color:' + r.color + '59}';
      }).join('\n');
  }

  function applyCarriers(rows) {
    if (!Array.isArray(rows) || !rows.length) return;
    // Livreurs Bellecave d'abord, puis transporteurs ; dans chaque catégorie, l'ordre choisi
    const rank = function (r) { return (r.grp === 'bellecave' ? 0 : 1000) + (r.sort || 0); };
    const active = rows.filter(function (r) { return r.active; }).sort(function (a, b) { return rank(a) - rank(b); });
    Object.keys(CARRIERS).forEach(function (k) { delete CARRIERS[k]; });
    Object.keys(CARRIER_DEPS).forEach(function (k) { delete CARRIER_DEPS[k]; });
    renames = {};
    active.forEach(function (r) {
      CARRIERS[r.id] = { label: r.label, color: r.color, grp: r.grp || 'transporteur' };
      CARRIER_DEPS[r.id] = r.deps.slice();
    });
    rows.forEach(function (r) { renames[r.id] = r.renames || {}; });
    GARAGES_DATA.forEach(fixGarage);
    injectColors(rows);
  }

  function applyEvents(rows) {
    events = {};
    (rows || []).forEach(function (r) {
      if (r.status !== 'normal') events[r.carrier_id + '|' + r.dep_time] = { status: r.status, delay: r.delay_min };
    });
  }

  // Au démarrage : on applique d'abord la copie locale (instantané, marche hors ligne)
  const cached = load('live_carriers');
  if (cached) applyCarriers(cached);
  const cachedEv = load('live_events');
  if (cachedEv && cachedEv.day === today()) applyEvents(cachedEv.rows);
  lastSync = load('live_sync');
  settings = load('live_settings') || {};

  // Signature de ce qui est affiché, pour savoir si un rafraîchissement a changé quelque chose
  let signature = JSON.stringify([cached, cachedEv && cachedEv.rows]);

  // Recharge depuis le serveur ; renvoie true si les horaires ou les retards ont changé
  async function refresh() {
    try {
      const rows = await get('carriers?select=id,label,deps,color,active,sort,renames,grp&order=sort');
      const day = today();
      const ev = await get('departure_events?select=carrier_id,dep_time,status,delay_min&day=eq.' + day);
      try {
        const st = await get('app_settings?select=key,value');
        settings = {};
        st.forEach(function (r) { settings[r.key] = r.value; });
        store('live_settings', settings);
        const hl = await get('health?select=key,at,info');
        health = {};
        hl.forEach(function (r) { health[r.key] = r; });
      } catch (e) {}
      applyCarriers(rows);
      applyEvents(ev);
      store('live_carriers', rows);
      store('live_events', { day: day, rows: ev });
      lastSync = new Date().toISOString();
      store('live_sync', lastSync);
      const sig = JSON.stringify([rows, ev, settings]);
      const changed = sig !== signature;
      signature = sig;
      return changed;
    } catch (e) { return false; } // hors ligne : on garde la copie locale
  }

  return {
    refresh: refresh,
    fixGarage: fixGarage,
    today: today,
    lastSync: function () { return lastSync; },
    // Retard ou annulation d'un départ précis, ou null
    event: function (cid, time) { return events[cid + '|' + time] || null; },
    events: function () {
      return Object.keys(events).map(function (k) {
        const p = k.split('|');
        return { cid: p[0], time: p[1], status: events[k].status, delay: events[k].delay };
      });
    },
    // Heure réelle de départ en minutes (avec le retard), ou null si annulé
    effMin: function (cid, time) {
      const e = events[cid + '|' + time];
      if (e && e.status === 'annule') return null;
      return toMin(time) + (e && e.status === 'retard' ? e.delay : 0);
    },
    fmt: fmt,
    // Délai de préparation avant chaque départ (réglé dans l'admin), 0 = pas affiché
    prepMinutes: function () { return Math.max(0, parseInt(settings.prep_minutes || '0') || 0); },
    setting: function (k) { return settings[k]; },
    // Minutes écoulées depuis le dernier passage du robot des alertes (null si inconnu)
    tickAge: function () {
      if (!health.tick) return null;
      return Math.round((Date.now() - new Date(health.tick.at).getTime()) / 60000);
    },
    health: function () { return health; },
    GROUPS: [['bellecave', 'Bellecave'], ['transporteur', 'Transporteurs']],
    // Identifiants des transporteurs actifs d'une catégorie, dans l'ordre d'affichage
    ids: function (grp) { return Object.keys(CARRIERS).filter(function (k) { return (CARRIERS[k].grp || 'transporteur') === grp; }); },
    toMin: toMin,
  };
})();
