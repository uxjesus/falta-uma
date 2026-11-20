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
const META_V = 2; // sobe quando a tabela de nomes muda: dado de versão antiga é refeito na próxima leitura
/* O TopDeck nomeia os decks com cores na frente ("Azorius Standstill", "Mono Blue Stiflenought", "5 Color Gro-A-Tog",
   "Wurg Terragedon"). Aqui o nome vira o do app pela palavra que identifica o deck, não pelo nome inteiro.
   Variantes de cor do mesmo deck somam juntas. Ordem importa: a primeira regra que bater vale. */
const ALIAS = [
  [/stiflenought/, "Stiflenought"],
  [/stand ?still|land ?still/, "Landstill"],
  [/gro-? ?a-? ?tog|psychatog/, "Psychatog"],
  [/madness/, "Madness"],
  [/enchantress/, "Enchantress"],
  [/goblins?/, "Goblins"],
  [/terrag?e?ddon|terragedon/, "Terrageddon"],
  [/replenish/, "Replenish"],
  [/\boath\b/, "Oath Ponza"],
  [/\bstasis\b/, "Stasis"],
  [/full english|^feb$/, "Full English Breakfast"],
  [/^mono[ -]?black$/, "Mono Black"],
  [/^(mono[ -]?red( aggro| burn)?|burn|sligh|red burn)$/, "Burn"],
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
  const nomes = {}; // "nome no TopDeck => nome no app": ajuda a achar nome novo sem reconhecer
  let matches = 0;
  for (const ev of events || []) {
    for (const rd of ev.rounds || []) {
      for (const t of rd.tables || []) {
        if (t.status !== "Completed" || !t.winner_id || t.winner_id === "Draw" || !t.players || t.players.length !== 2) continue;
        const [p1, p2] = t.players;
        const a1 = normArch(p1.archetype), a2 = normArch(p2.archetype);
        for (const [rw, nm] of [[p1.archetype, a1], [p2.archetype, a2]]) if (nm) { const kk = rw + " => " + nm; nomes[kk] = (nomes[kk] || 0) + 1; }
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
  return { v: META_V, events: (events || []).length, fonte: "TopDeck.gg (topdeck.gg), últimos " + DAYS + " dias", data: new Date().toISOString().slice(0, 10), format, matches, decks, nomes };
}
async function refreshAll(env) {
  const res = {};
  for (const f of FORMATS) {
    try {
      const m = await buildMeta(env, f);
      if (!m.matches) throw new Error("TopDeck respondeu, mas sem partidas com deck identificado (" + m.events + " torneios)");
      await env.BACKUP.put("meta:" + f, JSON.stringify(m)); await env.BACKUP.delete("meta-err:" + f); res[f] = m.matches;
    } catch (e) { res[f] = "erro: " + e.message; await env.BACKUP.put("meta-err:" + f, String(e.message).slice(0, 300), { expirationTtl: 86400 }); }
  }
  return res;
}
const pub = (obj, status = 200, cache = "public, max-age=3600") =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": cache } });

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(refreshAll(env)); },
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === "/meta" && req.method === "GET") {
      const f = url.searchParams.get("format") || "Premodern";
      const text = FORMATS.includes(f) ? await env.BACKUP.get("meta:" + f) : null;
      /* Sem dado, ou dado com mais de 8 dias: tenta buscar agora (no máximo uma vez a cada 10 minutos), sem esperar o sábado. */
      if (FORMATS.includes(f) && env.TOPDECK_KEY) {
        let old = true, wrongV = !text;
        try { const j = JSON.parse(text || "null"); wrongV = !j || j.v !== META_V; old = wrongV || Date.now() - Date.parse(j.data) > 8 * 86400000; } catch (e) {}
        if (old && !(await env.BACKUP.get("meta-try:" + f))) {
          await env.BACKUP.put("meta-try:" + f, "1", { expirationTtl: 600 });
          if (wrongV) { try { await refreshAll(env); const again = await env.BACKUP.get("meta:" + f); if (again) return new Response(again, { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } }); } catch (e) {} }
          else ctx.waitUntil(refreshAll(env));
        }
      }
      return text ? new Response(text, { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-cache" } }) : pub({ empty: true, err: (await env.BACKUP.get("meta-err:" + f)) || (env.TOPDECK_KEY ? null : "falta TOPDECK_KEY no servidor") }, 404, "no-store");
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
