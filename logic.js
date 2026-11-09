/* Falta Uma — regras puras (sem tela). Testável fora do navegador. */
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
  function parseList(text) {
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
      var name = m[2]
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
      if (lineMap[k]) { lineMap[k].qty += qty; return; }
      var card = { name: name, qty: qty, board: b, owned: 0 };
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
    var prev = {};
    oldCards.forEach(function (c) { prev[c.board + '|' + key(c.name)] = c.owned || 0; });
    newCards.forEach(function (c) {
      var o = prev[c.board + '|' + key(c.name)];
      c.owned = o ? Math.min(o, c.qty) : 0;
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

  var api = {
    consensus: consensus, buildIndex: buildIndex, matchName: matchName, resolveName: resolveName, cleanOcr: cleanOcr, norm: norm,
    typeGroup: typeGroup, GROUP_ORDER: GROUP_ORDER, parseMana: parseMana, toText: toText, mergeOwned: mergeOwned,
    parseList: parseList, aggregateMissing: aggregateMissing, deckProgress: deckProgress,
    toLigaMagic: toLigaMagic, isBasic: isBasic, key: key, missingOf: missingOf,
    matchFriendList: matchFriendList, ownedTotals: ownedTotals
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FU = api;
})(this);
