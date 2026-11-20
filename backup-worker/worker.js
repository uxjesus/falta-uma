// Playset: backup na nuvem. Guarda uma cópia dos decks por chave. Sem a chave certa, nada entra nem sai.
const ORIGIN = "https://uxjesus.github.io";
const MAX = 1500000;
const CORS = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
};
const out = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

/* ---------- Matchups (TopDeck.gg) ----------
   Toda semana (cron) o servidor lê os torneios recentes do TopDeck.gg, soma quem ganhou de quem
   por arquétipo e guarda o resultado. O app só lê /meta, sem chave. Dados: TopDeck.gg (https://topdeck.gg). */
const FORMATS = ["Premodern"];
const DAYS = 90;
const MIN_TOTAL = 30; // arquétipo com menos partidas que isso no período não entra
const ALIAS = [
  [/^(mono[ -]?red )?(sligh|burn)$|^mono[ -]?red$|^red burn$/, "Burn"],
  [/^(uw|wu|white blue|blue white) (land ?still|landstill|control)$|^land ?still$/, "Landstill"],
  [/^(ug|gu|blue green|green blue) madness$|^madness$/, "Madness"],
  [/^psychatog$|^(ub|bu) (tog|psychatog)$|^tog$/, "Psychatog"],
  [/^stiflenought$|^(uw|wu) stiflenought$/, "Stiflenought"],
  [/^goblins?$|^mono[ -]?red goblins?$/, "Goblins"],
  [/^enchantress$|^(gw|wg) enchantress$/, "Enchantress"],
  [/^oath( ponza)?$|^oath ponza$/, "Oath Ponza"],
  [/^replenish$/, "Replenish"],
  [/^stasis$/, "Stasis"],
  [/^terrageddon$/, "Terrageddon"],
  [/^mono[ -]?black( control)?$/, "Mono Black"],
  [/^(full english breakfast|feb)$/, "Full English Breakfast"],
];
function normArch(raw) {
  const k = String(raw || "").toLowerCase().replace(/[^a-z0-9 +-]/g, " ").replace(/\s+/g, " ").trim();
  if (!k || k === "unknown" || k === "other" || k === "rogue") return null;
  for (const [re, name] of ALIAS) if (re.test(k)) return name;
  return k.replace(/\b\w/g, (c) => c.toUpperCase());
}
async function buildMeta(env, format) {
  const r = await fetch("https://topdeck.gg/api/v2/tournaments", {
    method: "POST",
    headers: { "Authorization": env.TOPDECK_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ game: "Magic: The Gathering", format, last: DAYS, columns: ["name"], rounds: true }),
  });
  if (!r.ok) throw new Error("TopDeck respondeu " + r.status);
  const events = await r.json();
  const pair = {}; // "A|B" -> [vitórias de A sobre B, partidas]
  const total = {};
  let matches = 0;
  for (const ev of events || []) {
    for (const rd of ev.rounds || []) {
      for (const t of rd.tables || []) {
        if (t.status !== "Completed" || !t.winner_id || t.winner_id === "Draw" || !t.players || t.players.length !== 2) continue;
        const [p1, p2] = t.players;
        const a1 = normArch(p1.archetype), a2 = normArch(p2.archetype);
        if (!a1 || !a2) continue;
        const w = p1.id === t.winner_id ? a1 : a2, l = p1.id === t.winner_id ? a2 : a1;
        matches++;
        total[a1] = (total[a1] || 0) + 1; total[a2] = (total[a2] || 0) + 1;
        if (w === l) continue; // espelho não conta
        for (const [x, y, won] of [[w, l, 1], [l, w, 0]]) {
          const k = x + "|" + y;
          pair[k] = pair[k] || [0, 0];
          pair[k][0] += won; pair[k][1] += 1;
        }
      }
    }
  }
  const decks = {};
  for (const k of Object.keys(pair)) {
    const [x, y] = k.split("|");
    if ((total[x] || 0) < MIN_TOTAL) continue;
    (decks[x] = decks[x] || []).push({ opp: y, wr: Math.round((pair[k][0] / pair[k][1]) * 1000) / 10, n: pair[k][1] });
  }
  for (const x of Object.keys(decks)) decks[x].sort((a, b) => b.n - a.n);
  return { fonte: "TopDeck.gg (topdeck.gg), últimos " + DAYS + " dias", data: new Date().toISOString().slice(0, 10), format, matches, decks };
}
async function refreshAll(env) {
  const res = {};
  for (const f of FORMATS) {
    try { const m = await buildMeta(env, f); await env.BACKUP.put("meta:" + f, JSON.stringify(m)); res[f] = m.matches; }
    catch (e) { res[f] = "erro: " + e.message; }
  }
  return res;
}
const pub = (obj, status = 200, cache = "public, max-age=3600") =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": cache } });

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(refreshAll(env)); },
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === "/meta" && req.method === "GET") {
      const f = url.searchParams.get("format") || "Premodern";
      const text = FORMATS.includes(f) ? await env.BACKUP.get("meta:" + f) : null;
      return text ? new Response(text, { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" } }) : pub({ empty: true }, 404, "no-store");
    }
    if (url.pathname === "/meta/refresh" && req.method === "POST") {
      const tk = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!env.SYNC_TOKEN || tk !== env.SYNC_TOKEN) return out({ error: "chave inválida" }, 401);
      if (!env.TOPDECK_KEY) return out({ error: "falta TOPDECK_KEY" }, 412);
      return out(await refreshAll(env));
    }
    const token = env.SYNC_TOKEN;
    const sent = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!token || !sent || sent !== token) return out({ error: "chave inválida" }, 401);

    if (req.method === "GET") {
      const text = await env.BACKUP.get("current");
      if (!text) return out({ empty: true }, 404);
      const meta = JSON.parse((await env.BACKUP.get("current-meta")) || "{}");
      return out({ savedAt: meta.savedAt || null, data: JSON.parse(text) });
    }

    if (req.method === "PUT") {
      const text = await req.text();
      if (text.length > MAX) return out({ error: "grande demais" }, 413);
      let p;
      try { p = JSON.parse(text); } catch (e) { return out({ error: "json inválido" }, 400); }
      if (!p || p.app !== "falta-uma" || !p.state || !Array.isArray(p.state.decks)) return out({ error: "formato inválido" }, 400);
      if (p.state.decks.length === 0) return out({ error: "recusei salvar um backup sem decks" }, 422);
      const prev = await env.BACKUP.get("current");
      if (prev) await env.BACKUP.put("previous", prev);
      const savedAt = Date.now();
      await env.BACKUP.put("current", text);
      await env.BACKUP.put("current-meta", JSON.stringify({ savedAt }));
      return out({ ok: true, savedAt });
    }
    return out({ error: "método não permitido" }, 405);
  },
};
