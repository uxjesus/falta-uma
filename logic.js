/* Playset — regras puras (sem tela). Testável fora do navegador. */
(function (root) {
  'use strict';

  var BASICS = ['plains', 'island', 'swamp', 'mountain', 'forest', 'wastes',
    'snow-covered plains', 'snow-covered island', 'snow-covered swamp',
    'snow-covered mountain', 'snow-covered forest', 'snow-covered wastes'];

  function isBasic(name) {
    return BASICS.indexOf(String(name).trim().toLowerCase()) !== -1;
  }

  function key(name) {
    return String(name).trim().toLowerCase();
  }

  /* Lê listas em texto: "4 Counterspell", "4x Counterspell",
     "4 Counterspell (TMP) 57 *F*", seções Deck/Sideboard/Commander/Maybeboard. */
  function parseList(text, keepLines) {
    var lines = String(text || '').replace(/\r/g, '').split('\n');
    var board = 'main';
    var out = [];
    var skipped = [];
    var sawBlankAfterCards = false;
    var lineMap = {};
    var hasHeaders = /^\s*(deck|main|maindeck|main deck|mainboard|sideboard|side|sb|commander|comandante|maybeboard|maybe|considering)\s*:?\s*$/im.test(String(text || ''));

    lines.forEach(function (raw) {
      var line = raw.trim();
      if (!line) {
        if (out.length) sawBlankAfterCards = true;
        return;
      }
      var low = line.toLowerCase().replace(/[:\s]+$/, '');
      if (/^(deck|main|maindeck|main deck|mainboard)$/.test(low)) { board = 'main'; return; }
      if (/^(sideboard|side|sb)$/.test(low)) { board = 'side'; return; }
      if (/^(commander|comandante)$/.test(low)) { board = 'commander'; return; }
      if (/^(maybeboard|maybe|considering)$/.test(low)) { board = 'maybe'; return; }
      if (/^(companion|about|name\b)/.test(low)) { return; }
      if (line.indexOf('//') === 0 || line.indexOf('#') === 0) return;

      var sb = false;
      if (/^sb:\s*/i.test(line)) { sb = true; line = line.replace(/^sb:\s*/i, ''); }

      var m = line.match(/^(\d+)\s*[xX]?\s+(.+)$/);
      if (!m) { skipped.push(raw.trim()); return; }
      var qty = parseInt(m[1], 10);
      var rest = m[2];
      var unsure = /\?+\s*$/.test(rest);
      if (unsure) rest = rest.replace(/\s*\?+\s*$/, '');
      var foil = /\*F\*/i.test(rest);
      var em = rest.replace(/\s+\*[A-Za-z]+\*.*$/, '').match(/\s+\(([A-Za-z0-9]{2,6})\)(?:\s+([\w★†-]+))?\s*$/);
      var line1 = { n: qty, set: em ? em[1].toLowerCase() : '', num: em && em[2] ? em[2] : '', foil: foil, unsure: unsure };
      var name = rest
        .replace(/\s+\*[A-Z]+\*.*$/, '')           // *F*, *E*
        .replace(/\s+\([A-Za-z0-9]{2,6}\)(\s+[\w★-]+)?\s*$/, '') // (SET) 123
        .replace(/\s+#.*$/, '')
        .replace(/\s+\[[^\]]*\]\s*$/, '')          // [tags] do Moxfield/Archidekt
        .trim();
      if (!name || qty <= 0) { skipped.push(raw.trim()); return; }

      // MTGO sem cabeçalhos: cartas depois de uma linha em branco são sideboard
      var b = sb ? 'side' : board;
      if (!hasHeaders && sawBlankAfterCards) b = 'side';
      if (b === 'maybe') return;

      var k = b + '|' + key(name);
      if (lineMap[k]) { lineMap[k].qty += qty; if (keepLines) lineMap[k].lines.push(line1); return; }
      var card = { name: name, qty: qty, board: b, owned: 0 };
      if (keepLines) card.lines = [line1];
      lineMap[k] = card;
      out.push(card);
    });

    return { cards: out, skipped: skipped };
  }

  function missingOf(c) {
    return Math.max(0, (c.qty || 0) - (c.owned || 0));
  }

  /* Soma o que falta por carta entre todos os decks (todas as cópias, sem descontar
     cópias compartilhadas — decisão do Érick). Básicos ficam de fora. */
  function aggregateMissing(decks, canonical) {
    var map = {};
    var order = [];
    (decks || []).forEach(function (d) {
      (d.cards || []).forEach(function (c) {
        if (isBasic(c.name)) return;
        var miss = missingOf(c);
        if (!miss) return;
        var nm = canonical ? canonical(c.name) : c.name;
        var k = key(nm);
        if (!map[k]) { map[k] = { name: nm, total: 0, decks: [] }; order.push(k); }
        map[k].total += miss;
        var existing = null;
        map[k].decks.forEach(function (x) { if (x.deckId === d.id) existing = x; });
        if (existing) existing.qty += miss;
        else map[k].decks.push({ deckId: d.id, deckName: d.name, qty: miss });
      });
    });
    return order.map(function (k) { return map[k]; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  function deckProgress(d) {
    var need = 0, have = 0;
    (d.cards || []).forEach(function (c) {
      if (isBasic(c.name)) return;
      need += c.qty;
      have += Math.min(c.owned || 0, c.qty);
    });
    return { need: need, have: have, pct: need ? Math.round((have / need) * 100) : 100 };
  }


  /* Selo "Completo": só Premodern e Commander; listas avulsas nunca têm selo.
     Premodern: principal com 60+, sideboard com exatamente 15, tudo marcado como "tenho".
     Commander: 100 cartas (comandante incluso), tudo marcado como "tenho". Terreno básico não conta como posse. */
  function deckComplete(d) {
    if (!d || !d.cards || !d.cards.length) return false;
    var fmt = d.format, main = 0, side = 0;
    d.cards.forEach(function (c) { if (c.board === 'maybe') return; if (c.board === 'side') side += c.qty; else main += c.qty; });
    if (fmt === 'Premodern') { if (main < 60 || side !== 15) return false; }
    else if (fmt === 'Commander') { if (main + side !== 100) return false; }
    else return false;
    return d.cards.every(function (c) { return c.board === 'maybe' || isBasic(c.name) || (c.owned || 0) >= c.qty; });
  }

  /* Marca como "tenho" todas as cartas do deck (só marca, nunca desmarca). */
  function markAllOwned(cards) {
    (cards || []).forEach(function (c) { if (c.board !== 'maybe' && (c.owned || 0) < c.qty) c.owned = c.qty; });
    return cards;
  }

  /* Ordem da lista de decks: fixados primeiro; depois decks com cartas antes dos vazios; resto na ordem de criação. */
  function sortDecks(decks) {
    return decks.map(function (d, i) { return { d: d, i: i }; }).sort(function (a, b) {
      var pa = a.d.pinned ? 0 : 1, pb = b.d.pinned ? 0 : 1;
      if (pa !== pb) return pa - pb;
      var ea = (a.d.cards && a.d.cards.length) ? 0 : 1, eb = (b.d.cards && b.d.cards.length) ? 0 : 1;
      return ea - eb || a.i - b.i;
    }).map(function (x) { return x.d; });
  }


  /* Cartas-destaque para o fundo da home: as que "fazem o deck ser o deck".
     Fora: terrenos, básicos, cartas muito comuns (staples) e cartas que aparecem em 3+ decks do Érick.
     Pontua por: capa escolhida (sempre entra), cópias no deck, raridade entre os decks dele e preço. Máx. 3 por deck. */
  var STAPLES = ['counterspell', 'brainstorm', 'ponder', 'swords to plowshares', 'path to exile', 'lightning bolt', 'force of will', 'mana drain',
    'sol ring', 'wasteland', 'dark ritual', 'duress', 'mana leak', 'disenchant', 'preordain', 'opt', 'consider', 'mental misstep', 'daze', 'spell pierce',
    'abrupt decay', 'fatal push', 'thoughtseize', 'llanowar elves', 'birds of paradise', 'arcane signet', 'command tower', 'fellwar stone', 'mind stone'];
  function heroPool(decks, infoOf, usdOf, limit) {
    var real = (decks || []).filter(function (d) { return d.format !== 'Lista' && d.cards && d.cards.length; });
    var spread = {};
    real.forEach(function (d) { var seen = {}; d.cards.forEach(function (c) { var k = key(c.name); if (!seen[k]) { seen[k] = 1; spread[k] = (spread[k] || 0) + 1; } }); });
    var all = [];
    real.forEach(function (d) {
      var mine = [], cov = d.cover ? infoOf(d.cover) : null;
      if (cov && cov.art) mine.push({ name: cov.name || d.cover, art: cov.art, deck: d.name, deckId: d.id, score: 100 });
      d.cards.forEach(function (c) {
        if (c.board === 'side' || c.board === 'maybe' || isBasic(c.name)) return;
        var k = key(c.name), i = infoOf(c.name);
        if (!i || !i.art || /land/i.test(i.typeLine || '')) return;
        if (STAPLES.indexOf(k) >= 0 || (spread[k] || 1) >= 3) return;
        var usd = usdOf(i) || 0;
        var score = (c.board === 'commander' ? 6 : 0) + (c.qty >= 4 ? 3 : c.qty >= 3 ? 2 : c.qty >= 2 ? 1 : 0.5) + 2 / (spread[k] || 1) + Math.min(4, Math.log(1 + usd) / Math.LN10 * 2);
        mine.push({ name: i.name || c.name, art: i.art, deck: d.name, deckId: d.id, score: score });
      });
      mine.sort(function (a, b) { return b.score - a.score; });
      var got = {}, n = 0;
      mine.forEach(function (m) { if (n >= 3 || got[key(m.name)]) return; got[key(m.name)] = 1; n++; all.push(m); });
    });
    all.sort(function (a, b) { return b.score - a.score; });
    var out = [], seenN = {};
    all.forEach(function (m) { var k = key(m.name); if (seenN[k] || out.length >= (limit || 12)) return; seenN[k] = 1; out.push(m); });
    return out;
  }

  function toLigaMagic(items) {
    return items.map(function (i) { return i.total + ' ' + i.name; }).join('\n');
  }

  /* Cartas que eu tenho (somando o "tenho" de todos os decks). */
  function ownedTotals(decks, canonical) {
    var map = {};
    (decks || []).forEach(function (d) {
      (d.cards || []).forEach(function (c) {
        if (!c.owned) return;
        var nm = canonical ? canonical(c.name) : c.name;
        var k = key(nm);
        if (!map[k]) map[k] = { name: nm, qty: 0 };
        map[k].qty += c.owned;
      });
    });
    return map;
  }

  /* Cruza a lista de um amigo com o que eu tenho. */
  function matchFriendList(text, decks, canonical) {
    var parsed = parseList(text).cards;
    var mine = ownedTotals(decks, canonical);
    var res = [];
    var seen = {};
    parsed.forEach(function (c) {
      var nm = canonical ? canonical(c.name) : c.name;
      var k = key(nm);
      if (seen[k]) { seen[k].wants += c.qty; return; }
      var row = { name: nm, wants: c.qty, have: mine[k] ? mine[k].qty : 0 };
      seen[k] = row;
      res.push(row);
    });
    return res.filter(function (r) { return r.have > 0; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  /* Grupo por tipo, na ordem do MTG Goldfish/Moxfield. */
  var GROUPS = [
    ['creature', 'Criaturas'], ['planeswalker', 'Planeswalkers'], ['battle', 'Batalhas'],
    ['instant', 'Mágicas instantâneas'], ['sorcery', 'Feitiços'], ['artifact', 'Artefatos'],
    ['enchantment', 'Encantamentos'], ['land', 'Terrenos']
  ];
  function typeGroup(typeLine) {
    var t = String(typeLine || '').split(' // ')[0].toLowerCase();
    if (!t) return 'Outros';
    if (t.indexOf('creature') !== -1) return 'Criaturas';
    if (t.indexOf('planeswalker') !== -1) return 'Planeswalkers';
    if (t.indexOf('battle') !== -1) return 'Batalhas';
    if (t.indexOf('land') !== -1) return 'Terrenos';
    for (var i = 3; i < GROUPS.length; i++) if (t.indexOf(GROUPS[i][0]) !== -1) return GROUPS[i][1];
    return 'Outros';
  }
  var GROUP_ORDER = GROUPS.map(function (g) { return g[1]; }).concat(['Outros']);

  /* "{2}{U}{U}" -> ["2","U","U"]; "{W/U}" -> ["WU"] */
  function parseMana(cost) {
    var out = [];
    String(cost || '').replace(/\{([^}]+)\}/g, function (_, s) { out.push(s.replace('/', '')); return ''; });
    return out;
  }

  /* Junta a lista de volta em texto (para editar o deck). */
  function toText(cards) {
    var lab = { main: 'Deck', side: 'Sideboard', commander: 'Commander' };
    var out = [];
    ['commander', 'main', 'side'].forEach(function (b) {
      var cs = cards.filter(function (c) { return c.board === b; });
      if (!cs.length) return;
      if (out.length) out.push('');
      out.push(lab[b]);
      cs.forEach(function (c) { out.push(c.qty + ' ' + c.name); });
    });
    return out.join('\n');
  }

  /* Troca a lista mantendo o que eu já marquei como "tenho". */
  function mergeOwned(oldCards, newCards) {
    var prev = {}, prevEds = {};
    oldCards.forEach(function (c) { prev[c.board + '|' + key(c.name)] = c.owned || 0; prevEds[c.board + '|' + key(c.name)] = c.eds; });
    newCards.forEach(function (c) {
      var o = prev[c.board + '|' + key(c.name)];
      c.owned = o ? Math.min(o, c.qty) : 0;
      var pe = prevEds[c.board + '|' + key(c.name)];
      if (pe && c.owned) c.eds = edsTake(pe, c.owned).taken;
    });
    return newCards;
  }

  /* ---------- caderno de pesquisa ---------- */

  /* Junta as fontes: para cada carta, em quantas fontes aparece e a quantidade mais comum. */
  function consensus(sources) {
    var map = {}, order = [];
    var used = (sources || []).filter(function (s) { return s.cards && s.cards.length; });
    used.forEach(function (s) {
      var seen = {};
      s.cards.forEach(function (c) {
        if (isBasic(c.name)) return;
        var k = key(c.name);
        if (!map[k]) { map[k] = { name: c.name, count: 0, qtys: [], boards: {} }; order.push(k); }
        var m = map[k];
        if (!seen[k]) { m.count++; seen[k] = {}; m.qtys.push(seen[k]); }
        if (!seen[k][c.board]) m.boards[c.board] = (m.boards[c.board] || 0) + 1;
        seen[k][c.board] = (seen[k][c.board] || 0) + c.qty;
      });
    });
    return order.map(function (k) {
      var m = map[k];
      var board = Object.keys(m.boards).sort(function (a, b) { return m.boards[b] - m.boards[a] || (a === 'main' ? -1 : 1); })[0];
      var freq = {};
      m.qtys.forEach(function (x) { if (x[board]) freq[x[board]] = (freq[x[board]] || 0) + 1; });
      var mode = Object.keys(freq).map(Number).sort(function (a, b) { return freq[b] - freq[a] || b - a; })[0] || 1;
      return { name: m.name, count: m.count, total: used.length, qty: Math.min(mode, 99), board: board === 'maybe' ? 'main' : board };
    }).sort(function (a, b) { return b.count - a.count || a.name.localeCompare(b.name); });
  }

  /* Distância de edição (para corrigir nomes lidos no print). */
  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      var rowMin = i;
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }
  function norm(s) {
    return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[’`´]/g, "'").replace(/[^a-z0-9' ,:\/-]/g, '').replace(/\s+/g, ' ').trim();
  }

  /* Monta um índice de nomes oficiais para corrigir leituras. */
  function buildIndex(names) {
    var exact = {}, byLen = {};
    names.forEach(function (n) {
      var front = n.split(' // ')[0];
      [n, front].forEach(function (v) {
        var k = norm(v);
        if (!exact[k]) { exact[k] = n; (byLen[k.length] = byLen[k.length] || []).push(k); }
      });
    });
    return { exact: exact, byLen: byLen };
  }
  function matchName(raw, idx) {
    var k = norm(raw);
    if (!k) return null;
    if (idx.exact[k]) return { name: idx.exact[k], exact: true };
    var max = k.length < 6 ? 1 : (k.length < 12 ? 2 : 3);
    var best = null, bestD = max + 1;
    for (var L = k.length - max; L <= k.length + max; L++) {
      (idx.byLen[L] || []).forEach(function (cand) {
        if (bestD === 0) return;
        var d = lev(k, cand, Math.min(max, bestD));
        if (d < bestD) { bestD = d; best = cand; }
      });
    }
    return best ? { name: idx.exact[best], exact: false, dist: bestD } : null;
  }

  /* Resolve um nome lido: tenta o texto todo e vai tirando palavras soltas do fim ("Counterspell eee"). */
  function resolveName(raw, idx) {
    var words = String(raw).split(/\s+/).filter(Boolean);
    var fuzzy = null;
    for (var n = words.length; n >= 1 && n >= words.length - 3; n--) {
      var cand = words.slice(0, n).join(' ');
      if (norm(cand).length < 3) break;
      var m = matchName(cand, idx);
      if (!m) continue;
      if (m.exact) return { name: m.name, status: 'ok' };
      if (!fuzzy || m.dist < fuzzy.dist) fuzzy = m;
    }
    return fuzzy ? { name: fuzzy.name, status: 'fixed' } : { name: raw, status: 'unknown' };
  }

  /* Limpa o texto lido de um print: tira preço, símbolos soltos e lixo comum. */
  function cleanOcr(text) {
    return String(text || '').split('\n').map(function (l) {
      return l
        .replace(/[|•·»«©®™_]+/g, ' ')
        .replace(/(R\$|US\$|\$|€)\s*[\d.,]+/gi, ' ')
        .replace(/\s[\d]+[.,]\d{2}\s*$/, ' ')
        .replace(/^\s*[-*–—]+\s*/, '')
        .replace(/^\s*([0-9OoIl]{1,2})\s*[xX×]?\s+/, function (_, q) { return q.replace(/[Oo]/g, '0').replace(/[Il]/g, '1') + ' '; })
        .replace(/\s{2,}/g, ' ')
        .trim();
    }).filter(Boolean).join('\n');
  }

  /* Um campo só na Pesquisa: separa link, nome (texto solto) e lista de cartas. */
  var HEAD_RE = /^(deck|main|maindeck|main deck|mainboard|sideboard|side|sb|commander|comandante|maybeboard|maybe|considering)\s*:?$/i;
  function splitSource(text) {
    var url = '', label = '', list = [];
    String(text || '').replace(/\r/g, '').split('\n').forEach(function (raw) {
      var l = raw.trim();
      var m = l.match(/https?:\/\/\S+/i);
      if (m && !url) { url = m[0].replace(/[).,]+$/, ''); l = l.replace(m[0], '').trim(); if (!l) return; }
      if (!l) { list.push(''); return; }
      if (/^(sb:\s*)?\d{1,2}\s*[xX]?\s+\S/i.test(l) || HEAD_RE.test(l)) { list.push(l); return; }
      if (!label) label = l.slice(0, 80);
    });
    return { url: url, label: label, list: list.join('\n') };
  }

  /* Marca como "tenho" as cartas de uma lista colada. Sem número = todas as cópias. Só aumenta. */
  function markOwned(cards, text, canonical) {
    var lines = String(text || '').replace(/\r/g, '').split('\n').map(function (l) {
      var t = l.trim();
      if (!t || /^\d/.test(t) || /^sb:/i.test(t) || HEAD_RE.test(t)) return t;
      return '99 ' + t;
    });
    var parsed = parseList(lines.join('\n')).cards;
    var want = {}, names = {};
    parsed.forEach(function (c) {
      var nm = canonical ? canonical(c.name) : c.name;
      var k = key(nm);
      want[k] = (want[k] || 0) + c.qty; names[k] = nm;
    });
    var changed = 0, hit = {};
    cards.slice().sort(function (a, b) { return (a.board === 'side') - (b.board === 'side'); }).forEach(function (c) {
      var k = key(canonical ? canonical(c.name) : c.name);
      if (!want[k]) return;
      hit[k] = 1;
      var give = Math.min(c.qty, want[k]);
      if (give > (c.owned || 0)) { c.owned = give; changed++; }
      want[k] -= give;
    });
    return { changed: changed, notFound: Object.keys(names).filter(function (k) { return !hit[k]; }).map(function (k) { return names[k]; }) };
  }

  /* ---------- edição por cópia ----------
     eds = lista de { set, num, n }: as edições das cópias que a pessoa tem (soma <= quantidade que tem).
     Cópias sem edição conhecida ficam "no fim": ao tirar cópias, saem primeiro. */
  function edsSum(eds) { return (eds || []).reduce(function (a, e) { return a + (e.n || 0); }, 0); }
  function edsMerge(a, b) {
    var out = (a || []).map(function (e) { return { set: e.set, num: e.num, n: e.n }; });
    (b || []).forEach(function (e) {
      var f = out.filter(function (x) { return x.set === e.set && x.num === e.num; })[0];
      if (f) f.n += e.n; else out.push({ set: e.set, num: e.num, n: e.n });
    });
    return out;
  }
  function edsTake(eds, n) {
    var taken = [], rest = [], left = Math.max(0, n);
    (eds || []).forEach(function (e) {
      var t = Math.min(e.n, left);
      if (t > 0) taken.push({ set: e.set, num: e.num, n: t });
      if (e.n > t) rest.push({ set: e.set, num: e.num, n: e.n - t });
      left -= t;
    });
    return { taken: taken, rest: rest };
  }
  function edsPop(eds, total, n) {
    var known = edsSum(eds), unknown = Math.max(0, total - known);
    var pop = Math.min(known, Math.max(0, n - unknown));
    var r = edsTake(eds, known - pop);
    return { kept: r.taken, removed: r.rest };
  }

  /* Preço em reais como a Liga mostra ("R$ 1.234,56", "7,72", "3"). null = vazio ou "-"; NaN = não é número. */
  function parsePriceBR(tok) {
    var s = String(tok == null ? '' : tok).replace(/R\$/gi, '').replace(/\s/g, '');
    if (!s || /^[-–—?]+$/.test(s)) return null;
    if (!/^\d[\d.,]*$/.test(s)) return NaN;
    var m = s.match(/^(\d[\d.,]*?)[.,](\d{1,2})$/);
    return m ? parseFloat(m[1].replace(/[.,]/g, '') + '.' + m[2]) : parseFloat(s.replace(/[.,]/g, ''));
  }
  /* Lê a resposta da IA: "Nome em inglês | menor | médio | maior", uma carta por linha. */
  function parseLigaPrices(text) {
    var rows = [], skipped = [];
    String(text || '').replace(/```[a-z]*/gi, '').split(/\r?\n/).forEach(function (line) {
      var l = line.trim();
      if (!l || /^[|:\-\s]+$/.test(l)) return;
      l = l.replace(/^\|/, '').replace(/\|$/, '');
      var parts = l.split(/\s*[|\t;]\s*/).filter(function (x) { return x !== ''; });
      var name, toks;
      if (parts.length >= 2) { name = parts[0]; toks = parts.slice(1); }
      else {
        var w = l.replace(/R\$\s*/gi, '').split(/\s+/), t = [];
        while (w.length > 1 && t.length < 3 && /^(R\$)?[\d.,]+$|^[-–—]$/i.test(w[w.length - 1])) t.unshift(w.pop());
        name = w.join(' ').replace(/R\$$/i, '').trim(); toks = t;
      }
      name = name.replace(/[`*"]/g, '').replace(/^\s*[-•]\s*/, '').replace(/\s*\?+$/, '').trim();
      if (!name) return;
      var vals = toks.map(parsePriceBR);
      if (!vals.length || vals.some(function (v) { return v !== null && (isNaN(v) || v < 0); })) {
        if (!/^(nome|carta|card|name)\b/i.test(name)) skipped.push(l);
        return;
      }
      var min, avg, max;
      if (vals.length >= 3) { min = vals[0]; avg = vals[1]; max = vals[2]; }
      else if (vals.length === 1) { avg = vals[0]; min = null; max = null; }
      else { skipped.push(l); return; }
      if (!(avg > 0) || avg > 100000) { skipped.push(l); return; }
      var odd = (min != null && min > avg) || (max != null && max < avg);
      rows.push({ raw: name, name: name, min: min, avg: avg, max: max, odd: odd });
    });
    return { rows: rows, skipped: skipped };
  }

  /* ---------- metagame e confrontos (v0.21) ----------
     Os dados vêm da IA do próprio usuário, no formato PLAYSET-META v1:
       PLAYSET-META v1 / fonte: ... / data: AAAA-MM-DD / deck: Burn / Stiflenought|26|50
     Cada linha: adversário | taxa de vitória % do deck do usuário | partidas. */
  var META_MIN = 10;      // menos partidas que isso = "poucos dados"
  var META_SMALL = 30;    // abaixo disso o número ainda é só uma pista
  var META_STALE_DAYS = 14;
  var META_ARCHS = ['Stiflenought', 'Burn', 'Enchantress', 'Goblins', 'Mono Black', 'Terrageddon',
    'Replenish', 'Landstill', 'Oath Ponza', 'Psychatog', 'Full English Breakfast', 'Stasis', 'Madness'];

  /* Sugere o arquétipo pelo nome do deck. O usuário sempre pode corrigir. */
  function suggestArch(name) {
    var n = norm(name || '');
    var rules = [
      [/sligh|burn|mono ?red|\brdw\b/, 'Burn'], [/landstill/, 'Landstill'], [/psychatog|\btog\b/, 'Psychatog'],
      [/madness/, 'Madness'], [/stifle|dreadnought/, 'Stiflenought'], [/enchantress/, 'Enchantress'],
      [/goblin/, 'Goblins'], [/mono ?black/, 'Mono Black'], [/replenish/, 'Replenish'],
      [/terrageddon|terragedon/, 'Terrageddon'], [/oath|ponza/, 'Oath Ponza'],
      [/full english|breakfast/, 'Full English Breakfast'], [/stasis/, 'Stasis']
    ];
    for (var i = 0; i < rules.length; i++) if (rules[i][0].test(n)) return rules[i][1];
    return '';
  }

  function validDate(y, m, d) {
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  /* Lê o texto devolvido pela IA. Tolerante: aceita bloco de código, % e vírgula decimal. Nunca inventa. */
  function parseMeta(text) {
    var t = String(text || '').replace(/\r/g, '').replace(/```[a-z]*/gi, '');
    var out = { date: null, source: '', decks: {}, rows: 0, skipped: [], sawHeader: false };
    var cur = null;
    t.split('\n').forEach(function (raw) {
      var l = raw.trim();
      if (!l) return;
      var m;
      if (/^playset-meta\b/i.test(l)) { out.sawHeader = true; return; }
      if ((m = l.match(/^(?:fonte|source)\s*:\s*(.+)$/i))) { out.source = m[1].trim().slice(0, 80); return; }
      if ((m = l.match(/^(?:data|date)\s*:\s*(\d{4})-(\d{2})-(\d{2})/i))) {
        if (validDate(+m[1], +m[2], +m[3])) out.date = m[1] + '-' + m[2] + '-' + m[3];
        else out.skipped.push(l);
        return;
      }
      if ((m = l.match(/^deck\s*:\s*(.+)$/i))) {
        cur = m[1].trim().slice(0, 60);
        if (!out.decks[cur]) out.decks[cur] = [];
        return;
      }
      var p = l.split('|');
      if (cur && p.length >= 3) {
        var o = p[0].trim().slice(0, 60);
        var wr = parseFloat(String(p[1]).replace('%', '').replace(',', '.'));
        var nm = String(p[2]).trim().match(/^(\d+)(?:\s*(?:partidas?|matches|jogos))?$/i);
        var n = nm ? parseInt(nm[1], 10) : NaN;
        if (o && isFinite(wr) && wr >= 0 && wr <= 100 && n >= 1 && n <= 100000) {
          var arr = out.decks[cur], dup = arr.filter(function (r) { return key(r.o) === key(o); })[0];
          if (dup) { if (n > dup.n) { dup.wr = Math.round(wr * 10) / 10; dup.n = n; } }
          else { arr.push({ o: o, wr: Math.round(wr * 10) / 10, n: n }); out.rows++; }
          return;
        }
      }
      out.skipped.push(l);
    });
    Object.keys(out.decks).forEach(function (k) { if (!out.decks[k].length) delete out.decks[k]; });
    return out;
  }

  /* Lê a tabela copiada de uma página de arquétipo do MTG Decks ("Archetype | Winrate | Available Matches",
     ex.: "Tron | 100% | 2 matches"). Aceita colunas separadas por tab, barra, espaços ou uma célula por linha.
     Não sabe de que deck é a tabela: devolve o nome só se o título "Premodern X winrates" vier junto. */
  function parseMetaTable(text) {
    var out = { arch: '', list: [], rows: 0, skipped: [] };
    var t = String(text || '').replace(/\r/g, '');
    var mh = /premodern\s+(.+?)\s+winrates/i.exec(t);
    if (mh) out.arch = mh[1].trim().slice(0, 60);
    var name = '', wr = null, n = null;
    function push() {
      if (name && wr != null && n != null && wr >= 0 && wr <= 100 && n >= 1 && n <= 100000) {
        var dup = out.list.filter(function (r) { return key(r.o) === key(name); })[0];
        if (dup) { if (n > dup.n) { dup.wr = wr; dup.n = n; } } else { out.list.push({ o: name.slice(0, 60), wr: wr, n: n }); out.rows++; }
      }
      name = ''; wr = null; n = null;
    }
    var reLine = /^(.+?)[\s|]+(\d+(?:[.,]\d+)?)\s*%[\s|]+(\d+)\s*(?:matches?|partidas?|jogos)?$/i;
    t.split('\n').forEach(function (raw) {
      var l = raw.trim();
      if (!l) return;
      var m = reLine.exec(l);
      if (m) { name = m[1].trim(); wr = Math.round(parseFloat(m[2].replace(',', '.')) * 10) / 10; n = parseInt(m[3], 10); push(); return; }
      l.split(/\t|\||\s{2,}/).forEach(function (tok) {
        tok = tok.trim();
        if (!tok) return;
        var mp = /^(\d+(?:[.,]\d+)?)\s*%$/.exec(tok), mn = /^(\d+)\s*(?:matches?|partidas?|jogos)$/i.exec(tok);
        if (mp) { wr = Math.round(parseFloat(mp[1].replace(',', '.')) * 10) / 10; if (name && n != null) push(); }
        else if (mn) { n = parseInt(mn[1], 10); if (name && wr != null) push(); }
        else { if (name && (wr != null || n != null)) { out.skipped.push(name); } name = tok; wr = null; n = null; }
      });
    });
    return out;
  }

  /* base64url com UTF-8 (para o link #/meta?d=...). */
  function b64urlDecode(s) {
    var b = String(s || '').replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '');
    while (b.length % 4) b += '=';
    var bin = (typeof atob === 'function' ? atob : function (x) { return Buffer.from(x, 'base64').toString('binary'); })(b);
    var bytes = [];
    for (var i = 0; i < bin.length; i++) bytes.push('%' + ('00' + bin.charCodeAt(i).toString(16)).slice(-2));
    return decodeURIComponent(bytes.join(''));
  }
  function b64urlEncode(s) {
    var bin = unescape(encodeURIComponent(String(s)));
    var b = (typeof btoa === 'function' ? btoa : function (x) { return Buffer.from(x, 'binary').toString('base64'); })(bin);
    return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /* Acha os dados salvos de um arquétipo (sem diferenciar maiúsculas): { date, source, rows }. */
  function metaEntry(meta, arch) {
    if (!meta || !meta.decks || !arch) return null;
    var k = key(arch), hit = Object.keys(meta.decks).filter(function (x) { return key(x) === k; })[0];
    var e = hit ? meta.decks[hit] : null;
    return e && Array.isArray(e.rows) ? e : null;
  }

  /* Separa o que tem partidas suficientes do que não tem; ordena do pior para o melhor. */
  function metaSplit(rows) {
    var ok = [], few = [];
    (rows || []).forEach(function (r) { (r.n >= META_MIN ? ok : few).push(r); });
    ok.sort(function (a, b) { return a.wr - b.wr || b.n - a.n; });
    few.sort(function (a, b) { return b.n - a.n; });
    return { ok: ok, few: few, bad: ok.filter(function (r) { return r.wr < 50; }) };
  }

  function metaAgeDays(date, now) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
    if (!m) return null;
    var then = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    var n = new Date(now == null ? Date.now() : now);
    return Math.floor((Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) - then) / 86400000);
  }

  /* Notas de sideboard curadas, com palavras próprias e fonte. Só entra o que foi conferido na fonte.
     chave: "meu deck|adversário". "in" = cartas que o guia sugere trazer; "expect" = o que o adversário traz contra mim. */
  var SIDE_NOTES = {
    'Burn|Stiflenought': {
      in: ['Mogg Salvage', 'Overload'],
      lines: [
        'Guia de Mono Red Sligh: Mogg Salvage e Overload funcionam bem contra o Stiflenought (respondem aos artefatos dele). O guia diz que o Stiflenought gasta mana com muita eficiência, então vale cortar cartas caras e as que dão brecha para Hydroblast e Foil/Daze ganharem tempo.'
      ],
      expect: 'Um guia de Stiflenought diz que, contra Sligh, ele troca as cartas de compra (4 Accumulated Knowledge e 2 Flash of Insight saem) por 3 Hydroblast, 2 Essence Flare e 1 Powder Keg. Essence Flare cuida das criaturas vermelhas baratas e guarda os Hydroblast para alvos melhores.',
      infer: 'Inferência minha: como o outro lado traz respostas baratas, muitas ameaças baratas pesam mais do que poucas caras.',
      src: [
        { label: 'Cardsrealm: guia de Mono Red Sligh', url: 'https://mtg.cardsrealm.com/en-us/p/250319', date: null },
        { label: 'Ultimate Guard: guia de Stiflenought', url: 'https://ultimateguard.com/en/blog/mastering-stiflenought-in-premodern-deck-guide-strategy-sideboard-plans', date: '2026-02-17' }
      ]
    }
  };
  function sideNote(arch, opp) { return SIDE_NOTES[arch + '|' + opp] || null; }

  /* Onde está cada carta sugerida: no sideboard, no principal, na coleção ou "você não tem".
     collInfo(nome) -> { total, spare } da Coleção (cartas marcadas como "tenho"). */
  function noteCardStatus(name, deck, canonical, collInfo) {
    var k = key(canonical ? canonical(name) : name);
    var cards = (deck && deck.cards) || [];
    var hit = function (board) {
      return cards.filter(function (c) { return (board === 'side' ? c.board === 'side' : c.board !== 'side') && key(canonical ? canonical(c.name) : c.name) === k; })[0];
    };
    var s = hit('side'), m = hit('main');
    if (s) return { name: name, where: 'side', have: s.owned || 0, qty: s.qty };
    if (m) return { name: name, where: 'main', have: m.owned || 0, qty: m.qty };
    var ci = collInfo ? collInfo(name) : null;
    if (ci && ci.total > 0) return { name: name, where: 'colecao', have: ci.total, spare: ci.spare || 0 };
    return { name: name, where: 'nao', have: 0 };
  }

  var api = {
    META_MIN: META_MIN, META_SMALL: META_SMALL, META_STALE_DAYS: META_STALE_DAYS, META_ARCHS: META_ARCHS,
    suggestArch: suggestArch, parseMeta: parseMeta, parseMetaTable: parseMetaTable, b64urlDecode: b64urlDecode, b64urlEncode: b64urlEncode,
    metaEntry: metaEntry, metaSplit: metaSplit, metaAgeDays: metaAgeDays, sideNote: sideNote, noteCardStatus: noteCardStatus,
    parsePriceBR: parsePriceBR, parseLigaPrices: parseLigaPrices,
    edsSum: edsSum, edsMerge: edsMerge, edsTake: edsTake, edsPop: edsPop,
    splitSource: splitSource, markOwned: markOwned,
    consensus: consensus, buildIndex: buildIndex, matchName: matchName, resolveName: resolveName, cleanOcr: cleanOcr, norm: norm,
    typeGroup: typeGroup, GROUP_ORDER: GROUP_ORDER, parseMana: parseMana, toText: toText, mergeOwned: mergeOwned,
    parseList: parseList, aggregateMissing: aggregateMissing, deckProgress: deckProgress, deckComplete: deckComplete, heroPool: heroPool, markAllOwned: markAllOwned, sortDecks: sortDecks,
    toLigaMagic: toLigaMagic, isBasic: isBasic, key: key, missingOf: missingOf,
    matchFriendList: matchFriendList, ownedTotals: ownedTotals
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FU = api;
})(this);
