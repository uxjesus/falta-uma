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

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
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
