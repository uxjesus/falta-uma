/* Playset — tela e dados. Depende de logic.js (window.FU). */
(function () {
  'use strict';
  var FU = window.FU;
  var STATE_KEY = 'fu.state.v1';
  var CARDS_KEY = 'fu.cards.v1';
  var SCRY = 'https://api.scryfall.com';
  var SYM = 'https://svgs.scryfall.io/card-symbols/';
  var STALE_MS = 6 * 60 * 60 * 1000;
  var BACKUP_NAG_DAYS = 14;
  var DATA_VERSION = 2; // sobe quando o app passa a guardar campos novos da carta
  var APP_VERSION = '0.32.0';
  var SNAP_KEY = 'fu.snap.v1'; var SYNC_KEY = 'fu.sync.v1'; var SYNC_URL = 'https://playset-backup.sr-carjes.workers.dev/';
  var VER_KEY = 'fu.appver';

  /* ---------- cópia de segurança automática ----------
     Antes de qualquer outra coisa mexer nos dados, na primeira abertura de cada versão nova
     o app guarda uma cópia dos decks como estavam. Só existe uma cópia (a mais recente). */
  function takeSnap(reason, raw) {
    try {
      if (!raw) return false;
      var p = JSON.parse(raw);
      if (!p || !p.decks || !p.decks.length) return false; // nunca troca uma cópia boa por um estado vazio
      localStorage.setItem(SNAP_KEY, JSON.stringify({ at: Date.now(), reason: reason, raw: raw }));
      return true;
    } catch (e) { return false; }
  }
  function readSnap() {
    try { var s = JSON.parse(localStorage.getItem(SNAP_KEY)); return s && s.raw ? s : null; } catch (e) { return null; }
  }
  (function () {
    try {
      if (localStorage.getItem(VER_KEY) !== APP_VERSION) {
        takeSnap('Antes de atualizar para a v' + APP_VERSION, localStorage.getItem(STATE_KEY));
        localStorage.setItem(VER_KEY, APP_VERSION);
      }
    } catch (e) {}
  })();

  /* ---------- armazenamento ---------- */
  function load(k, fallback) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function save(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (e) { toast('Não consegui salvar no aparelho. Faça um backup.'); return false; }
  }
  var state = load(STATE_KEY, null) || { decks: [], lastBackup: null, changedAt: null };
  state.ui = state.ui || { sort: 'name', deck: 'all', view: {} };
  var db = load(CARDS_KEY, null) || { cards: {}, alias: {}, updatedAt: null, rate: null };
  function persist(changed) { if (changed) state.changedAt = Date.now(); var ok = save(STATE_KEY, state); if (changed) scheduleSync(); return ok; }
  function persistDb() { db.v = DATA_VERSION; save(CARDS_KEY, db); }

  function cardInfo(name) {
    var k = FU.key(name);
    return db.cards[db.alias[k] || k] || null;
  }
  function canonical(name) { var i = cardInfo(name); return i && !i.notFound ? i.name : name; }
  function deckById(id) { return state.decks.filter(function (x) { return x.id === id; })[0]; }
  /* Edição preferida (arte) que o Érick escolheu no pop-up da carta. O preço segue a edição mais barata. */
  function prefOf(info) { return info && state.pref ? state.pref[FU.key(info.name)] || null : null; }
  function imgOf(info) { var p = prefOf(info); return (p && p.img) || (info && info.img) || null; }
  function artOf(info) { var p = prefOf(info); return (p && p.art) || (info && info.art) || null; }

  /* ---------- formatação ---------- */
  var brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  var brl0 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  var usdF = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' });
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDate(ts) {
    if (!ts) return null;
    var d = new Date(ts);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' às ' +
      d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  function ago(ts) {
    if (!ts) return null;
    var m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'agora';
    if (m < 60) return 'há ' + m + ' min';
    var h = Math.round(m / 60);
    if (h < 24) return 'há ' + h + ' h';
    var d = Math.round(h / 24);
    return 'há ' + d + (d === 1 ? ' dia' : ' dias');
  }
  /* Preço: 1) o que o Érick anotou da Liga Magic; 2) edição mais barata no Scryfall; 3) edição padrão. */
  function ligaNote(info) {
    if (!info || !state.liga) return null;
    return state.liga[FU.key(info.name)] || null;
  }
  function unitUsd(info) {
    if (!info) return null;
    var v = info.minUsd != null ? info.minUsd : (info.usd != null ? info.usd : info.usdFoil);
    return v != null ? Number(v) : null;
  }
  function unitBrl(info) {
    var n = ligaNote(info);
    if (n) return n.brl;
    var u = unitUsd(info);
    if (u == null || !db.rate || !db.rate.brl) return null;
    return u * db.rate.brl;
  }
  function moneyShort(info, qty) {
    var b = unitBrl(info);
    if (b != null) return brl.format(b * (qty || 1));
    var u = unitUsd(info);
    if (u != null) return usdF.format(u * (qty || 1));
    return null;
  }

  var COLOR_NAMES = { W: 'branco', U: 'azul', B: 'preto', R: 'vermelho', G: 'verde', C: 'incolor', X: 'X', S: 'neve' };
  function manaHtml(cost) {
    var syms = FU.parseMana(cost);
    if (!syms.length) return '';
    var label = syms.map(function (s) { return COLOR_NAMES[s] || s.split('').map(function (c) { return COLOR_NAMES[c] || c; }).join(' ou '); }).join(', ');
    return '<span class="mana" role="img" aria-label="Custo: ' + esc(label) + '">' +
      syms.map(function (s) { return '<img src="' + SYM + encodeURIComponent(s) + '.svg" alt="" data-sym="' + esc(s) + '" width="16" height="16" loading="lazy">'; }).join('') + '</span>';
  }
  function pipsHtml(colors) {
    if (!colors || !colors.length) return '';
    return '<span class="pips" role="img" aria-label="Cores: ' + colors.map(function (c) { return COLOR_NAMES[c] || c; }).join(', ') + '">' +
      colors.map(function (c) { return '<img src="' + SYM + c + '.svg" alt="" data-sym="' + c + '" width="18" height="18">'; }).join('') + '</span>';
  }
  var PH = { W: '#f8f6d8', U: '#c1d7e9', B: '#bab1ab', R: '#e49977', G: '#a3c095' };
  function phStyle(info) {
    var cs = (info && info.colors) || [];
    if (!cs.length) return 'background:linear-gradient(135deg,#cbc2bf,#9d9592)';
    if (cs.length === 1) return 'background:linear-gradient(135deg,' + PH[cs[0]] + ',' + PH[cs[0]] + 'aa)';
    return 'background:linear-gradient(135deg,' + cs.map(function (c) { return PH[c] || '#ccc'; }).join(',') + ')';
  }
  function thumbHtml(info, name) {
    if (artOf(info)) return '<img class="thumb" src="' + esc(artOf(info)) + '" alt="" width="56" height="41" loading="lazy" decoding="async">';
    return '<span class="thumb ph" style="' + phStyle(info) + '" aria-hidden="true">' + esc(String(name).slice(0, 2)) + '</span>';
  }

  /* imagem que falhou (sem internet e sem cache): troca por texto/placeholder */
  document.addEventListener('error', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'IMG') return;
    if (el.hasAttribute('data-sym')) {
      var s = document.createElement('span'); s.className = 't'; s.textContent = el.getAttribute('data-sym');
      el.replaceWith(s);
    } else if (el.classList.contains('thumb') || el.classList.contains('art') || el.classList.contains('cardimg') || el.closest('.gcard') || el.closest('.cp') || el.closest('.edline')) {
      el.style.visibility = 'hidden';
    }
  }, true);

  /* ---------- avisos ---------- */
  var toastTimer;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2800);
  }

  /* ---------- Scryfall ---------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function mapCard(c) {
    var face = (c.card_faces && c.card_faces[0]) || {};
    var iu = c.image_uris || face.image_uris || {};
    return {
      name: c.name, typeLine: c.type_line || face.type_line || '',
      manaCost: c.mana_cost || face.mana_cost || '', cmc: c.cmc || 0,
      colors: c.color_identity || [],
      img: iu.normal || null, art: iu.art_crop || null,
      usd: c.prices && c.prices.usd, usdFoil: c.prices && c.prices.usd_foil, eur: c.prices && c.prices.eur,
      scryfall: c.scryfall_uri, gatherer: c.related_uris && c.related_uris.gatherer,
      rulingsUri: c.rulings_uri, rulings: null, updatedAt: Date.now()
    };
  }
  function storeCard(requested, c) {
    var info = mapCard(c);
    var k = FU.key(info.name);
    var prev = db.cards[k];
    if (prev && prev.rulings) info.rulings = prev.rulings;
    db.cards[k] = info;
    db.alias[FU.key(requested)] = k;
    if (info.name.indexOf(' // ') !== -1) db.alias[FU.key(info.name.split(' // ')[0])] = k;
  }
  function allNames() {
    var set = {};
    state.decks.forEach(function (d) {
      d.cards.forEach(function (c) { set[FU.key(c.name)] = c.name; });
    });
    var sp = state.spare || {};
    Object.keys(sp).forEach(function (k) { if (sp[k] && sp[k].qty > 0 && sp[k].name) set[FU.key(sp[k].name)] = sp[k].name; });
    return Object.keys(set).map(function (k) { return set[k]; });
  }

  var refreshing = false;
  function refreshPrices(opts) {
    opts = opts || {};
    if (refreshing) return Promise.resolve();
    if (!navigator.onLine) { if (!opts.silent) toast('Sem internet. Mostrando os preços salvos.'); return Promise.resolve(); }
    var names = opts.only || allNames();
    if (!names.length) return Promise.resolve();
    refreshing = true;
    setStatus();
    var chunks = [];
    for (var i = 0; i < names.length; i += 75) chunks.push(names.slice(i, i + 75));
    var notFound = [];
    var p = fetchRate();
    chunks.forEach(function (chunk, idx) {
      p = p.then(function () { return idx ? sleep(120) : null; }).then(function () {
        return fetch(SCRY + '/cards/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ identifiers: chunk.map(function (n) { return { name: n }; }) })
        }).then(function (r) {
          if (!r.ok) throw new Error('Scryfall ' + r.status);
          return r.json();
        }).then(function (json) {
          var byKey = {};
          chunk.forEach(function (n) { byKey[FU.key(n)] = n; });
          (json.data || []).forEach(function (c) {
            var req = byKey[FU.key(c.name)] || (c.card_faces && byKey[FU.key(c.card_faces[0].name)]) || c.name;
            storeCard(req, c);
          });
          (json.not_found || []).forEach(function (nf) { if (nf.name) notFound.push(nf.name); });
        });
      });
    });
    p = p.then(function () {
      var q = Promise.resolve();
      notFound.slice(0, 25).forEach(function (n) {
        q = q.then(function () { return sleep(110); }).then(function () {
          return fetch(SCRY + '/cards/named?fuzzy=' + encodeURIComponent(n), { headers: { 'Accept': 'application/json' } })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (c) {
              if (c && c.object === 'card') storeCard(n, c);
              else db.cards[FU.key(n)] = { name: n, notFound: true, updatedAt: Date.now() };
            }).catch(function () {});
        });
      });
      return q;
    });
    p = p.then(function () { return fetchMinPrices(names); });
    return p.then(function () {
      db.updatedAt = Date.now();
      persistDb();
      refreshing = false;
      if (!opts.silent) toast('Preços atualizados.');
      render();
    }).catch(function () {
      refreshing = false;
      persistDb();
      if (!opts.silent) toast('Não consegui falar com o Scryfall. Mantive os preços salvos.');
      render();
    });
  }
  /* Edição mais barata (papel, válida em torneio: sem borda dourada, sem Collectors' Edition). */
  var MIN_TTL = 20 * 60 * 60 * 1000;
  function fetchMinPrices(names) {
    var seen = {}, todo = [];
    names.forEach(function (n) {
      var i = cardInfo(n);
      if (!i || i.notFound || FU.isBasic(i.name) || seen[i.name]) return;
      seen[i.name] = 1;
      if (i.minAt && Date.now() - i.minAt < MIN_TTL) return;
      todo.push(i);
    });
    var q = Promise.resolve();
    todo.forEach(function (info, idx) {
      q = q.then(function () { return sleep(110); }).then(function () {
        if (idx % 5 === 0) { statusExtra = 'Buscando a edição mais barata (' + (idx + 1) + '/' + todo.length + ')…'; setStatus(); }
        var query = '!"' + info.name.split(' // ')[0] + '" game:paper -border:gold -set:ced -set:cei -set:30a -is:oversized -is:playtest';
        return fetch(SCRY + '/cards/search?unique=prints&order=usd&dir=asc&q=' + encodeURIComponent(query), { headers: { 'Accept': 'application/json' } })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            if (!j || !j.data) return;
            var best = null;
            j.data.forEach(function (c) {
              var v = c.prices && (c.prices.usd || c.prices.usd_foil);
              if (v != null && (best === null || Number(v) < best.v)) best = { v: Number(v), set: c.set_name };
            });
            info.minUsd = best ? best.v : null;
            info.minSet = best ? best.set : null;
            info.minAt = Date.now();
          }).catch(function () {});
      });
    });
    return q.then(function () { statusExtra = ''; });
  }
  var statusExtra = '';

  function fetchRate() {
    return fetch('https://open.er-api.com/v6/latest/USD')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.rates && j.rates.BRL) db.rate = { brl: j.rates.BRL, at: Date.now() }; })
      .catch(function () {});
  }
  function fetchRulings(info) {
    if (!info || !info.rulingsUri || !navigator.onLine) return Promise.resolve(info && info.rulings);
    return fetch(info.rulingsUri, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return info.rulings;
        info.rulings = (j.data || []).map(function (x) { return { date: x.published_at, text: x.comment }; });
        persistDb();
        return info.rulings;
      }).catch(function () { return info.rulings; });
  }
  function stampHtml() {
    var cls = 'stamp', txt;
    if (refreshing) txt = 'Atualizando preços…';
    else if (!db.updatedAt) { txt = 'Preços ainda não baixados'; cls += ' old'; }
    else {
      txt = 'Preços ' + ago(db.updatedAt);
      if (Date.now() - db.updatedAt > 3 * 864e5) cls += ' old';
    }
    return '<p class="' + cls + '" id="priceStatus" aria-live="polite"><span class="dot" aria-hidden="true"></span>' + esc(txt) + '</p>';
  }
  function setStatus() {
    var el = document.getElementById('priceStatus');
    if (el) el.outerHTML = stampHtml();
  }

  /* ---------- compartilhar / copiar ---------- */
  function copyText(text, okMsg) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast(okMsg); } catch (e) { toast('Não consegui copiar.'); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, fallback);
    else fallback();
  }
  function shareText(title, text) {
    if (navigator.share) navigator.share({ title: title, text: text }).catch(function () {});
    else copyText(text, 'Lista copiada. Cole no WhatsApp.');
  }

  /* ---------- modal da carta ---------- */
  var dlg = document.getElementById('cardDialog');
  var dlgBody = document.getElementById('dlgBody');
  var lastFocus = null;
  var openName = null;
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', function () {
    var nm = openName; openName = null;
    if (!lastFocus) return;
    var y = window.scrollY;
    render();
    window.scrollTo(0, y);
    var el = nm && main.querySelector('[data-card="' + (window.CSS && CSS.escape ? CSS.escape(nm) : nm) + '"]');
    if (el) el.focus({ preventScroll: true });
  });

  /* Cartas marcadas como "tenho" que não estão em nenhum deck: ficam na Coleção (e ajudam na troca com amigos).
     Cada entrada guarda as edições das cópias (eds), quando conhecidas. */
  function spareMap() { state.spare = state.spare || {}; return state.spare; }
  function putSpare(name, n, eds) {
    if (!(n > 0)) return;
    var s = spareMap(), nm = canonical(name), k = FU.key(nm), prev = s[k];
    s[k] = { name: nm, qty: Math.min(999, ((prev && prev.qty) || 0) + n), eds: FU.edsMerge(prev && prev.eds, FU.edsTake(eds, n).taken) };
  }
  function takeSpareEds(name, want) {
    var s = spareMap(), k = FU.key(canonical(name));
    if (!s[k] || !(want > 0)) return { n: 0, eds: [] };
    var got = Math.min(want, s[k].qty);
    var pop = FU.edsPop(s[k].eds, s[k].qty, got);
    s[k].qty -= got; s[k].eds = pop.kept;
    if (s[k].qty <= 0) delete s[k];
    return { n: got, eds: pop.removed };
  }
  /* "Em consideração" entra na conta do que falta como carta "maybe": ter = cópias soltas na coleção. */
  function consCards(d) {
    return (d.format === 'Lista' ? [] : d.consider || []).map(function (c) { return { name: c.name, qty: c.qty, board: 'maybe', owned: Math.min(c.qty, spareQty(c.name)) }; });
  }
  function missingAgg(decks) {
    return FU.aggregateMissing((decks || []).map(function (d) {
      return d && d.format !== 'Lista' && d.consider && d.consider.length ? { id: d.id, name: d.name, format: d.format, cards: d.cards.concat(consCards(d)) } : d;
    }), canonical);
  }
  function takeSpare(name, want) { return takeSpareEds(name, want).n; }
  function spareQty(name) { var s = spareMap()[FU.key(canonical(name))]; return s ? s.qty : 0; }
  function decksWithSpare() {
    var s = spareMap();
    var cards = Object.keys(s).map(function (k) { return { name: s[k].name, qty: s[k].qty, owned: s[k].qty, board: 'main' }; });
    return cards.length ? state.decks.concat([{ id: 'spare', name: 'Coleção', cards: cards }]) : state.decks;
  }
  function removeCard(d, i) {
    var c = d.cards[i];
    if (!c) return;
    putSpare(c.name, c.owned || 0, c.eds);
    d.cards.splice(i, 1);
    if (d.cover && FU.key(d.cover) === FU.key(canonical(c.name)) && !d.cards.some(function (x) { return FU.key(canonical(x.name)) === FU.key(d.cover); })) d.cover = null;
  }
  function setQty(c, q) {
    q = Math.max(1, Math.min(99, q));
    if (q < (c.owned || 0)) { var pp = FU.edsPop(c.eds, c.owned, c.owned - q); putSpare(c.name, c.owned - q, pp.removed); c.eds = pp.kept; c.owned = q; }
    if (q > c.qty && (c.owned || 0) < q) { var tk = takeSpareEds(c.name, q - (c.owned || 0)); c.owned = (c.owned || 0) + tk.n; c.eds = FU.edsMerge(c.eds, tk.eds); }
    c.qty = q;
  }
  function moveBoard(d, i) {
    var c = d.cards[i];
    if (!c) return;
    var to = c.board === 'side' ? 'main' : 'side';
    var ex = d.cards.filter(function (x) { return x !== c && x.board === to && FU.key(canonical(x.name)) === FU.key(canonical(c.name)); })[0];
    if (ex) { ex.qty = Math.min(99, ex.qty + c.qty); ex.owned = Math.min(ex.qty, (ex.owned || 0) + (c.owned || 0)); ex.eds = FU.edsMerge(ex.eds, c.eds); d.cards.splice(i, 1); }
    else c.board = to;
  }

  /* ---------- edições das cópias que a pessoa tem ---------- */
  function edsFor(nm) {
    var out = [], total = 0;
    ownedLines(nm).forEach(function (l) { var o = l.c.owned || 0; total += o; out = FU.edsMerge(out, FU.edsTake(l.c.eds, o).taken); });
    var s = spareMap()[FU.key(nm)];
    if (s) { total += s.qty; out = FU.edsMerge(out, FU.edsTake(s.eds, s.qty).taken); }
    return { eds: out, total: total };
  }
  function prInfo(e) { return (db.pr || {})[e.set + '/' + e.num] || null; }
  function edLabel(e) { var p = prInfo(e); return (p && p.setName ? p.setName : String(e.set).toUpperCase()) + ' #' + e.num; }
  function edsShort(eds) { return eds.map(function (e) { return String(e.set).toUpperCase() + (e.n > 1 ? '×' + e.n : ''); }).join(', '); }
  function copiesHtml(nm) {
    var r = edsFor(nm), known = FU.edsSum(r.eds);
    if (!known) return '';
    var unk = r.total - known;
    return '<div class="dlg-sec"><h3>Suas cópias</h3><ul class="copies">' + r.eds.map(function (e) {
      var p = prInfo(e);
      return '<li><span class="cp">' + (p && p.sm ? '<img src="' + esc(p.sm) + '" alt="" width="72" height="100" loading="lazy">' : '<span class="cph" aria-hidden="true">' + esc(String(e.set).toUpperCase()) + '</span>') + '</span>' +
        '<span class="cl"><strong>×' + e.n + '</strong> ' + esc(edLabel(e)) + (p && p.year ? ' · ' + esc(p.year) : '') + '</span></li>';
    }).join('') + (unk > 0 ? '<li><span class="cl"><strong>×' + unk + '</strong> <span class="muted">edição não informada</span></span></li>' : '') + '</ul></div>';
  }

  function ownedLines(nm) {
    var out = [];
    state.decks.forEach(function (d) {
      d.cards.forEach(function (c, i) {
        if (FU.key(canonical(c.name)) === FU.key(nm)) out.push({ d: d, c: c, i: i });
      });
    });
    return out;
  }
  function ownHtml(nm) {
    var lines = ownedLines(nm);
    if (!lines.length) return '';
    return '<div class="dlg-sec"><h3>Nos seus decks e listas</h3>' + lines.map(function (l) {
      var bl = l.c.board === 'side' ? 'Sideboard' : (l.c.board === 'commander' ? 'Comandante' : 'Principal');
      var at = ' data-d="' + esc(l.d.id) + '" data-i="' + l.i + '"';
      var who = esc(l.d.name) + (l.c.board === 'side' ? ' (sideboard)' : '');
      return '<div class="ownrow2"><p class="hd"><a href="#/deck/' + esc(l.d.id) + '" data-close>' + esc(l.d.name) + '</a> <span class="xs muted">· ' + bl +
        (FU.missingOf(l.c) ? ' · <strong style="color:var(--miss)">faltam ' + FU.missingOf(l.c) + '</strong>' : ' · completo') + '</span></p>' +
        '<div class="ctl"><span id="lq' + l.i + esc(l.d.id) + '">No deck</span><div class="stepper" role="group" aria-labelledby="lq' + l.i + esc(l.d.id) + '">' +
        '<button data-mqty="-1"' + at + ' aria-label="Uma a menos no deck ' + who + '"' + (l.c.qty <= 1 ? ' disabled' : '') + '>−</button>' +
        '<output aria-live="polite">' + l.c.qty + '</output>' +
        '<button data-mqty="1"' + at + ' aria-label="Uma a mais no deck ' + who + '"' + (l.c.qty >= 99 ? ' disabled' : '') + '>+</button></div></div>' +
        '<div class="ctl"><span id="lo' + l.i + esc(l.d.id) + '">Tenho</span><div class="stepper" role="group" aria-labelledby="lo' + l.i + esc(l.d.id) + '">' +
        '<button data-mown="-1"' + at + ' aria-label="Tenho uma a menos em ' + who + '"' + (l.c.owned <= 0 ? ' disabled' : '') + '>−</button>' +
        '<output aria-live="polite">' + l.c.owned + '/' + l.c.qty + '</output>' +
        '<button data-mown="1"' + at + ' aria-label="Tenho uma a mais em ' + who + '"' + (l.c.owned >= l.c.qty ? ' disabled' : '') + '>+</button></div></div>' +
        '<div class="act">' + (l.c.board !== 'commander' ? '<button class="link" data-mmove' + at + '>' + (l.c.board === 'side' ? 'Mover para o principal' : 'Mover para o sideboard') + '</button>' : '<span></span>') +
        '<button class="link danger" data-mdel' + at + '>Tirar ' + (l.d.format === 'Lista' ? 'da lista' : 'do deck') + '</button></div></div>';
    }).join('') + '</div>';
  }
  function spareHtml(nm) {
    var n = spareQty(nm);
    if (!n) return '';
    return '<div class="dlg-sec"><h3>Na coleção, fora dos decks</h3><p class="small">Você tem <strong>' + n + '</strong> fora dos decks. Elas contam na troca com amigos e voltam sozinhas se a carta entrar num deck.</p>' +
      '<button class="link" data-spareclear>Não tenho mais</button></div>';
  }
  function addToHtml(nm) {
    if (!state.decks.length) return '';
    var r = route(), cur = r.name === 'deck' ? r.id : null;
    var lists = state.decks.filter(function (d) { return d.format === 'Lista'; });
    var def = cur || (lists[0] && lists[0].id) || state.decks[0].id;
    var opts = state.decks.slice().sort(function (a, b) { return (a.format === 'Lista') - (b.format === 'Lista'); });
    return '<div class="dlg-sec"><h3><label for="addTo">Adicionar a um deck ou lista</label></h3><div class="addto">' +
      '<select id="addTo" class="field">' + opts.map(function (d) { return '<option value="' + esc(d.id) + '"' + (d.id === def ? ' selected' : '') + '>' + esc(d.name) + (d.format === 'Lista' ? ' (lista)' : '') + '</option>'; }).join('') + '</select>' +
      '<button class="btn" data-addto>' + ICON.plus + 'Adicionar</button></div></div>';
  }

  function openCard(name, trigger) {
    lastFocus = trigger || lastFocus;
    var info = cardInfo(name);
    var nm = info && !info.notFound ? info.name : name;
    openName = name;
    var liga = 'https://www.ligamagic.com.br/?view=cards/card&card=' + encodeURIComponent(nm.split(' // ')[0]);
    var uUsd = unitUsd(info);
    var note = ligaNote(info);
    var est = uUsd != null && db.rate && db.rate.brl ? uUsd * db.rate.brl : null;
    var estLine = uUsd != null
      ? (est != null ? '≈ ' + brl.format(est) + ' · ' : '') + usdF.format(uUsd) + (info.minSet ? ' na edição mais barata (' + esc(info.minSet) + ')' : '') + ' no Scryfall, mercado americano'
      : null;
    var priceHtml = note
      ? '<p class="big">' + brl.format(note.brl) + '</p><p class="xs muted">' + (note.src === 'print' ? 'Preço médio de venda na Liga Magic em ' : 'Anotado da Liga Magic em ') + esc(fmtDate(note.at)) + ' (' + ligaAgeText(note) + ')</p>' +
        (ligaDays(note) > LIGA_STALE ? '<p class="small" style="margin-top:4px;color:var(--miss);font-weight:700">Preço antigo. Confira na Liga antes de fechar a troca.</p>' : '') +
        (note.src === 'print' && (note.min != null || note.max != null) ? '<p class="small" style="margin-top:4px">Menor <strong>' + (note.min != null ? brl.format(note.min) : '-') + '</strong> · Maior <strong>' + (note.max != null ? brl.format(note.max) : '-') + '</strong></p>' : '') + (estLine ? '<p class="xs muted" style="margin-top:4px">Referência: ' + estLine + '</p>' : '')
      : estLine
        ? '<p class="big">' + (est != null ? '≈ ' + brl.format(est) : usdF.format(uUsd)) + '</p><p class="xs muted">' + usdF.format(uUsd) + (info.minSet ? ' na edição mais barata (' + esc(info.minSet) + ')' : '') + ' no Scryfall (mercado americano), convertido pelo dólar do dia · ' + esc(ago(info.minAt || info.updatedAt)) + '</p>'
        : '<p class="muted small">' + (info && info.notFound ? 'Não encontrei esta carta no Scryfall. Confira o nome no deck.' : 'Sem preço salvo ainda. Toque em Atualizar com internet.') + '</p>';
    var noteForm = info && !info.notFound
      ? '<form class="ligaform" data-liga="' + esc(info.name) + '" novalidate><label for="ligaIn" class="small" style="margin:12px 0 6px">Preço que você viu na Liga Magic (fica salvo sem internet)</label>' +
        '<div style="display:grid;grid-template-columns:1fr auto;gap:8px"><input id="ligaIn" type="text" inputmode="decimal" autocomplete="off" placeholder="Ex.: 12,50" value="' + (note ? esc(String(note.brl.toFixed(2)).replace('.', ',')) : '') + '">' +
        '<button class="btn" type="submit">Salvar</button></div>' +
        (note ? '<button class="link" type="button" data-ligaclear style="margin-top:4px">Apagar preço anotado</button>' : '') + '</form>'
      : '';
    syncEdIdx(info);
    var scroll = dlg.open ? dlgBody.scrollTop : 0;
    dlgBody.innerHTML =
      '<div class="dlg-top"><div><h2 id="dlgTitle">' + esc(nm) + '</h2>' +
      '<p class="sub">' + manaHtml(info && info.manaCost) + (info && info.typeLine ? '<span>' + esc(info.typeLine) + '</span>' : '') + '</p></div>' +
      '<button class="ib" id="dlgClose" aria-label="Fechar">' +
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>' +
      (imgOf(info) ? '<img class="cardimg" src="' + esc(imgOf(info)) + '" alt="Carta ' + esc(nm) + '" width="488" height="680" decoding="async"><div class="edbar" id="edbar">' + edbarHtml(info) + '</div>' : '<div style="height:8px"></div>') +
      '<div class="dlg-sec"><h3>Preço</h3>' + priceHtml +
      '<div class="links"><a class="btn primary" href="' + esc(liga) + '" target="_blank" rel="noopener">Ver preço na Liga Magic' +
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg></a>' +
      '<div class="links2">' +
      (info && info.scryfall ? '<a class="btn" href="' + esc(info.scryfall) + '" target="_blank" rel="noopener">Regras</a>' : '') +
      (info && info.gatherer ? '<a class="btn" href="' + esc(info.gatherer) + '" target="_blank" rel="noopener">Gatherer</a>' : '') +
      '</div></div>' + noteForm + '</div>' +
      copiesHtml(nm) + ownHtml(nm) + addToHtml(nm) + spareHtml(nm) + coverHtml(nm) +
      '<div id="rulings" class="rulings"></div>';
    document.getElementById('dlgClose').addEventListener('click', function () { dlg.close(); });
    dlgBody.querySelectorAll('[data-close]').forEach(function (a) { a.addEventListener('click', function () { lastFocus = null; dlg.close(); }); });
    if (!dlg.open) dlg.showModal();
    dlgBody.scrollTop = scroll;
    renderRulings(info && info.rulings);
    if (info && !info.notFound && !info.rulings) fetchRulings(info).then(function (r) { if (dlg.open) renderRulings(r); });
  }
  dlgBody.addEventListener('submit', function (e) {
    var f = e.target.closest('[data-liga]');
    if (!f) return;
    e.preventDefault();
    var raw = (f.querySelector('input').value || '').replace(/[^\d,.]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
    var v = parseFloat(raw);
    if (!(v > 0) || v > 100000) { toast('Digite um valor, ex.: 12,50'); f.querySelector('input').focus(); return; }
    state.liga = state.liga || {};
    state.liga[FU.key(f.getAttribute('data-liga'))] = { brl: Math.round(v * 100) / 100, at: Date.now() };
    persist(true);
    toast('Preço da Liga anotado.');
    openCard(openName);
  });
  dlgBody.addEventListener('click', function (e) {
    if (e.target.closest('[data-ligaclear]')) {
      var f = e.target.closest('[data-liga]');
      if (state.liga) delete state.liga[FU.key(f.getAttribute('data-liga'))];
      persist(true);
      toast('Preço anotado apagado.');
      openCard(openName);
      return;
    }
    var cv = e.target.closest('[data-cover]');
    if (cv) {
      var cd = deckById(cv.getAttribute('data-cover'));
      if (!cd) return;
      var cnm = canonical(openName);
      var was = cd.cover && FU.key(cd.cover) === FU.key(cnm);
      cd.cover = was ? null : cnm;
      persist(true);
      toast(was ? 'Capa removida. Volto a escolher sozinho.' : 'Capa do deck escolhida.');
      openCard(openName);
      var cb = dlgBody.querySelector('[data-cover="' + cd.id + '"]');
      if (cb) cb.focus();
      return;
    }
    if (e.target.closest('[data-edload]')) { loadPrints(cardInfo(openName)); return; }
    var ed = e.target.closest('[data-ed]');
    if (ed) { stepPrint(+ed.getAttribute('data-ed')); return; }
    if (e.target.closest('[data-edreset]')) { resetPrint(); return; }
    if (e.target.closest('[data-spareclear]')) {
      delete spareMap()[FU.key(canonical(openName))];
      persist(true); toast('Tirei das guardadas.'); openCard(openName); return;
    }
    if (e.target.closest('[data-addto]')) {
      var ad = deckById(document.getElementById('addTo').value);
      if (!ad) return;
      var anm = canonical(openName);
      var already = ad.cards.some(function (c) { return c.board === 'main' && FU.key(canonical(c.name)) === FU.key(anm); });
      if (already) { toast('Já está em ' + ad.name + '. Ajuste a quantidade acima.'); return; }
      addToDeck(ad, anm, 1, 'main');
      persist(true); toast('Adicionada a ' + ad.name + '.');
      openCard(openName);
      var nb = dlgBody.querySelector('[data-mqty="1"][data-d="' + ad.id + '"]');
      if (nb) nb.focus();
      return;
    }
    var mt = e.target.closest('[data-mqty],[data-mmove],[data-mdel]');
    if (mt) {
      var md = deckById(mt.getAttribute('data-d')), mi = +mt.getAttribute('data-i');
      var mc = md && md.cards[mi];
      if (!mc) return;
      var focusSel = null;
      if (mt.hasAttribute('data-mqty')) {
        setQty(mc, mc.qty + (+mt.getAttribute('data-mqty')));
        focusSel = '[data-mqty="' + mt.getAttribute('data-mqty') + '"][data-d="' + md.id + '"][data-i="' + mi + '"]';
      } else if (mt.hasAttribute('data-mmove')) {
        moveBoard(md, mi); toast(mc.board === 'side' ? 'Movida para o sideboard.' : 'Movida para o principal.');
      } else {
        var had = mc.owned || 0;
        removeCard(md, mi);
        toast('Tirada de ' + md.name + '.' + (had ? ' Guardei a marcação de ' + had + (had === 1 ? ' cópia.' : ' cópias.') : ''));
        focusSel = '[data-addto]';
      }
      persist(true);
      openCard(openName);
      var mf = (focusSel && dlgBody.querySelector(focusSel + ':not([disabled])')) || dlgBody.querySelector('#dlgClose');
      if (mf) mf.focus();
      return;
    }
    var t = e.target.closest('[data-mown]');
    if (!t) return;
    var d = deckById(t.getAttribute('data-d'));
    var c = d && d.cards[+t.getAttribute('data-i')];
    if (!c) return;
    var oldO = c.owned;
    c.owned = Math.max(0, Math.min(c.qty, c.owned + (+t.getAttribute('data-mown'))));
    if (c.owned < oldO) c.eds = FU.edsPop(c.eds, oldO, oldO - c.owned).kept;
    persist(true);
    var sel = '[data-mown="' + t.getAttribute('data-mown') + '"][data-d="' + t.getAttribute('data-d') + '"][data-i="' + t.getAttribute('data-i') + '"]';
    openCard(openName);
    var again = dlgBody.querySelector(sel + ':not([disabled])') || dlgBody.querySelector('[data-d="' + t.getAttribute('data-d') + '"][data-i="' + t.getAttribute('data-i') + '"]:not([disabled])');
    if (again) again.focus();
  });
  var STAR = function (on) { return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path fill="' + (on ? 'currentColor' : 'none') + '" d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/></svg>'; };
  function coverHtml(nm) {
    var decks = [];
    ownedLines(nm).forEach(function (l) { if (decks.indexOf(l.d) === -1) decks.push(l.d); });
    if (!decks.length) return '';
    return '<div class="dlg-sec"><h3>Capa do deck</h3><div class="links">' + decks.map(function (d) {
      var on = !!(d.cover && FU.key(d.cover) === FU.key(nm));
      return '<button class="btn" data-cover="' + esc(d.id) + '" aria-pressed="' + on + '">' + STAR(on) + 'Capa de ' + esc(d.name) + '</button>';
    }).join('') + '</div></div>';
  }

  /* ---------- edições (artes) da carta ---------- */
  var printsCache = {}, edIdx = 0;
  function syncEdIdx(info) {
    var list = info && printsCache[FU.key(info.name)];
    if (!list) return;
    var p = prefOf(info), cur = imgOf(info);
    edIdx = 0;
    list.forEach(function (x, i) { if ((p && x.id === p.id) || (!p && x.img === cur)) edIdx = i; });
  }
  function edbarHtml(info) {
    if (!info || info.notFound) return '';
    var list = printsCache[FU.key(info.name)];
    var p = prefOf(info);
    if (!list) {
      return '<button class="link full" data-edload>' + svg('<rect x="7" y="3" width="13" height="16" rx="2"/><path d="M4 7v12a2 2 0 0 0 2 2h10"/>') + 'Ver outras artes (edições)</button>' +
        (p ? '<p class="xs muted full">Mostrando a arte da sua edição' + (p.set ? ' (' + esc(p.set) + ')' : '') + '. O preço continua o da edição mais barata.</p>' : '');
    }
    var cur = list[edIdx] || list[0];
    return '<button class="ib" data-ed="-1" aria-label="Edição anterior">' + ICON.back + '</button>' +
      '<p aria-live="polite"><strong>' + esc(cur.set) + '</strong><br><span class="xs muted">' + (edIdx + 1) + ' de ' + list.length + (cur.year ? ' · ' + esc(cur.year) : '') + '</span></p>' +
      '<button class="ib" data-ed="1" aria-label="Próxima edição">' + ICON.next + '</button>' +
      '<p class="xs muted full">A arte que ficar aqui é a que o app mostra. O preço continua o da edição mais barata.' +
      (p ? ' <button class="link" data-edreset>Voltar à arte padrão</button>' : '') + '</p>';
  }
  function setEdbar(info, focusSel) {
    var bar = document.getElementById('edbar');
    if (!bar) return;
    bar.innerHTML = edbarHtml(info);
    var f = focusSel && bar.querySelector(focusSel);
    if (f) f.focus();
  }
  function loadPrints(info) {
    if (!info || info.notFound) return;
    if (!navigator.onLine) { toast('Sem internet para buscar as edições.'); return; }
    var k = FU.key(info.name);
    var bar = document.getElementById('edbar');
    if (bar) bar.innerHTML = '<p class="small full" role="status">Buscando edições…</p>';
    var q = '!"' + info.name.split(' // ')[0] + '" game:paper';
    fetch(SCRY + '/cards/search?unique=prints&order=released&dir=desc&q=' + encodeURIComponent(q), { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var list = [];
        ((j && j.data) || []).forEach(function (c) {
          var iu = c.image_uris || (c.card_faces && c.card_faces[0] && c.card_faces[0].image_uris) || {};
          if (iu.normal) list.push({ id: c.id, set: c.set_name, year: (c.released_at || '').slice(0, 4), img: iu.normal, art: iu.art_crop || null });
        });
        if (!list.length) { toast('Não encontrei outras edições.'); setEdbar(info); return; }
        printsCache[k] = list;
        syncEdIdx(info);
        if (FU.key(canonical(openName || '')) === k) setEdbar(info, '[data-ed="1"]');
      }).catch(function () { toast('Não consegui buscar as edições.'); setEdbar(info); });
  }
  function stepPrint(dir) {
    var info = cardInfo(openName);
    if (!info) return;
    var k = FU.key(info.name), list = printsCache[k];
    if (!list) return;
    edIdx = (edIdx + dir + list.length) % list.length;
    var x = list[edIdx];
    state.pref = state.pref || {};
    if (x.img === info.img) delete state.pref[k];
    else state.pref[k] = { id: x.id, set: x.set, img: x.img, art: x.art };
    persist(true);
    var im = dlgBody.querySelector('.cardimg');
    if (im) { im.style.visibility = ''; im.src = x.img; }
    setEdbar(info, '[data-ed="' + dir + '"]');
  }
  function resetPrint() {
    var info = cardInfo(openName);
    if (!info || !state.pref) return;
    delete state.pref[FU.key(info.name)];
    persist(true);
    syncEdIdx(info);
    var im = dlgBody.querySelector('.cardimg');
    if (im && info.img) im.src = info.img;
    setEdbar(info, '[data-ed="1"]');
    toast('Voltei à arte padrão.');
  }

  function renderRulings(list) {
    var el = document.getElementById('rulings');
    if (!el) return;
    if (!list || !list.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="dlg-sec"><h3>Rulings · salvos para usar sem internet</h3><ul>' +
      list.map(function (r) { return '<li>' + esc(r.text) + ' <span class="muted xs">(' + esc(r.date) + ')</span></li>'; }).join('') + '</ul></div>';
  }

  /* ---------- telas ---------- */
  var main = document.getElementById('main');
  var barAction = document.getElementById('barAction');
  var fab = document.getElementById('fab');
  function svg(p, w) { return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="' + (w || 2) + '" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>'; }
  var ICON = {
    refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
    share: svg('<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4"/>'),
    copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>', 2.4),
    back: svg('<path d="M15 6l-6 6 6 6"/>', 2.2),
    next: svg('<path d="M9 6l6 6-6 6"/>', 2.2),
    edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>')
  };
  function needsBackup() {
    if (!state.decks.length || !state.changedAt) return false;
    var last = state.lastBackup;
    if (last && last >= state.changedAt) return false;
    return !last || Math.floor((Date.now() - last) / 864e5) >= BACKUP_NAG_DAYS;
  }
  function featured(d) {
    if (d.cover) { var ci = cardInfo(d.cover); if (ci && artOf(ci)) return ci; }
    var best = null, bestV = -Infinity;
    d.cards.forEach(function (c) {
      if (FU.isBasic(c.name)) return;
      var i = cardInfo(c.name);
      if (!i || !artOf(i)) return;
      var v = c.board === 'commander' ? 1e9 : (unitUsd(i) || 0) - (/land/i.test(i.typeLine) ? 1e6 : 0);
      if (v > bestV) { best = i; bestV = v; }
    });
    return best;
  }
  function deckColors(d) {
    var set = {};
    d.cards.forEach(function (c) { var i = cardInfo(c.name); (i && i.colors || []).forEach(function (x) { set[x] = 1; }); });
    return ['W', 'U', 'B', 'R', 'G'].filter(function (c) { return set[c]; });
  }
  function deckValue(d, onlyMissing) {
    var v = 0;
    d.cards.forEach(function (c) {
      if (FU.isBasic(c.name)) return;
      var b = unitBrl(cardInfo(c.name));
      if (b != null) v += b * (onlyMissing ? FU.missingOf(c) : c.qty);
    });
    return v;
  }
  var LIGA_STALE = 30;
  function ligaDays(n) { return n && n.at ? Math.floor((Date.now() - n.at) / 864e5) : 0; }
  function ligaUrl(name) { return 'https://www.ligamagic.com.br/?view=cards/card&card=' + encodeURIComponent(String(name).split(' // ')[0]); }
  function ligaSearchUrl(text) { return 'https://www.ligamagic.com.br/?view=cards/search&card=' + encodeURIComponent(text); }
  function ligaAgeText(n) { var d = ligaDays(n); return d < 1 ? 'hoje' : (d === 1 ? 'há 1 dia' : 'há ' + d + ' dias'); }
  function priceCell(info, qty) {
    var t = moneyShort(info, qty), n = ligaNote(info);
    if (!t) return '<span class="pr na">' + (info && info.notFound ? 'não achei' : '—') + '</span>';
    var stale = n && ligaDays(n) > LIGA_STALE;
    return '<span class="pr' + (stale ? ' old' : '') + '">' + t + (n ? '<small>Liga' + (stale ? ' · ' + ligaAgeText(n) : '') + '</small>' : '') + '</span>';
  }
  var ICO_EXT = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>';
  /* Na linha da lista: custo de mana + atalho de um toque para a página da carta na Liga Magic. */
  function rowTools(info, name) {
    var nm = info && !info.notFound ? info.name : name;
    return '<span class="rx">' + manaHtml(info && info.manaCost) +
      '<a class="lg" href="' + esc(ligaUrl(nm)) + '" target="_blank" rel="noopener" aria-label="Ver ' + esc(nm) + ' na Liga Magic (abre no navegador)">' + ICO_EXT + '</a></span>';
  }
  function priceStatus() {
    if (refreshing) return '<span id="priceStatus" aria-live="polite">' + esc(statusExtra || 'Atualizando preços…') + '</span>';
    if (!db.updatedAt) return '<span id="priceStatus" aria-live="polite"><span class="dot-old" aria-hidden="true"></span>Sem preços ainda</span>';
    var old = Date.now() - db.updatedAt > 3 * 864e5;
    return '<span id="priceStatus" aria-live="polite"><span class="' + (old ? 'dot-old' : 'dot-ok') + '" aria-hidden="true"></span>Preços ' + esc(ago(db.updatedAt)) + '</span>';
  }
  stampHtml = priceStatus;
  function groupByType(list, nameOf) {
    var map = {};
    list.forEach(function (x) {
      var i = cardInfo(nameOf(x));
      var g = FU.typeGroup(i && i.typeLine);
      (map[g] = map[g] || []).push(x);
    });
    return FU.GROUP_ORDER.filter(function (g) { return map[g]; }).map(function (g) { return { title: g, items: map[g] }; });
  }
  function sortItems(arr, nameOf, qtyOf) {
    if (state.ui.sort === 'price') {
      return arr.sort(function (a, b) {
        return (unitUsd(cardInfo(nameOf(b))) || 0) * qtyOf(b) - (unitUsd(cardInfo(nameOf(a))) || 0) * qtyOf(a) || nameOf(a).localeCompare(nameOf(b));
      });
    }
    if (state.ui.sort === 'cmc') {
      return arr.sort(function (a, b) {
        var ia = cardInfo(nameOf(a)), ib = cardInfo(nameOf(b));
        return ((ia && ia.cmc) || 0) - ((ib && ib.cmc) || 0) || nameOf(a).localeCompare(nameOf(b));
      });
    }
    return arr.sort(function (a, b) { return nameOf(a).localeCompare(nameOf(b)); });
  }
  function sortSelect() {
    var o = [['name', 'Nome'], ['price', 'Preço'], ['cmc', 'Custo']];
    return '<label class="visually-hidden" for="fSort">Ordenar por</label><select id="fSort" data-sortsel>' +
      o.map(function (x) { return '<option value="' + x[0] + '"' + (state.ui.sort === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select>';
  }

  /* Selos do deck: sempre ícone + palavra (nunca só cor). */
  function sealsHtml(d) {
    var out = '';
    if (d.pinned) out += '<span class="seal pin">' + ICO.pin + 'Fixado</span>';
    if (FU.deckComplete(d)) out += '<span class="seal ok">' + ICO.check + 'Completo</span>';
    return out ? '<span class="seals">' + out + '</span>' : '';
  }

  function viewDecks() {
    fab.innerHTML = '';
    barAction.innerHTML = '<a class="ib" href="#/novo" aria-label="Novo deck">' + ICON.plus + '</a>';
    if (!state.decks.length) {
      return '<div class="card empty stack"><h1 style="font-size:1.5rem">Decks</h1><p class="muted">Nenhum deck ainda.</p>' +
        '<a class="btn primary full" href="#/novo">Adicionar deck</a><button class="btn full" data-act="example">Ver com decks de exemplo</button></div>';
    }
    var html = '<header class="head"><h1>Decks</h1><p class="metaline">' + (function () { var nl = state.decks.filter(function (x) { return x.format === 'Lista'; }).length, nd = state.decks.length - nl; return nd + (nd === 1 ? ' deck' : ' decks') + (nl ? ' · ' + nl + (nl === 1 ? ' lista' : ' listas') : ''); })() + '</p></header>';
    var fl = formats();
    fl.forEach(function (fm) {
    var inF = FU.sortDecks(state.decks.filter(function (d) { return fmtOf(d) === fm; }));
    if (fl.length > 1) html += '<h2 class="sec-h fmt-h">' + esc(fm === 'Lista' ? 'Listas' : fm) + ' <span class="c">(' + inF.length + ')</span></h2>';
    html += '<ul class="decklist">';
    inF.forEach(function (d) {
      var p = FU.deckProgress(d);
      var miss = p.need - p.have;
      var f = featured(d);
      var mv = deckValue(d, true);
      html += '<li><a class="dk" href="#/deck/' + esc(d.id) + '"><div class="art" style="' + (f ? '' : phStyle({ colors: deckColors(d) })) + '">' +
        (f ? '<img src="' + esc(artOf(f)) + '" alt="" loading="lazy" decoding="async">' : '') +
        '<span class="badge">' + esc(d.format || 'Sem formato') + '</span>' + pipsHtml(deckColors(d)) + '</div>' +
        '<div class="body"><strong>' + esc(d.name) + '</strong>' + sealsHtml(d) +
        '<div class="ln"><span>' + (d.cards.length ? p.pct + '% pronto · ' + (miss ? 'faltam ' + miss : 'completo') : (d.format === 'Lista' ? 'Lista vazia' : 'Sem cartas · ' + ((d.sources || []).length || 0) + ((d.sources || []).length === 1 ? ' fonte' : ' fontes'))) + '</span><span>' + (mv ? '≈ ' + brl0.format(mv) : '') + '</span></div>' +
        '<div class="bar" aria-hidden="true"><span style="width:' + p.pct + '%"></span></div></div></a></li>';
    });
    html += '</ul>';
    });
    return html + '<div style="padding:4px 16px 16px"><a class="btn full" href="#/novo/lista">' + ICON.plus + 'Nova lista de cartas avulsas</a><button class="btn full" data-photo="novo" style="margin-top:8px">' + ICO.cam + 'Importar deck por foto</button></div>';
  }

  function ownBtn(c, idx) {
    var cls = c.owned >= c.qty ? 'done' : (c.owned > 0 ? 'part' : 'none');
    var txt = c.owned >= c.qty ? '✓' : c.owned + '/' + c.qty;
    return '<button class="own ' + cls + '" data-own="toggle" data-i="' + idx + '" aria-label="Tenho ' + c.owned + ' de ' + c.qty + '. Tocar para marcar ' + (c.owned >= c.qty ? 'nenhuma' : 'todas') + '"><i>' + txt + '</i></button>';
  }
  function deckRow(d, c) {
    var idx = d.cards.indexOf(c);
    var info = cardInfo(c.name);
    return '<li class="r"><span class="q' + (FU.missingOf(c) ? ' miss' : '') + '">' + c.qty + '</span>' +
      '<button class="nm" data-card="' + esc(c.name) + '">' + esc(canonical(c.name)) + (info && info.notFound ? '<span class="flag">não achei</span>' : '') + '</button>' +
      rowTools(info, c.name) + ownBtn(c, idx) + '</li>';
  }
  function gridCard(d, c) {
    var info = cardInfo(c.name);
    var miss = FU.missingOf(c);
    return '<li><button class="gc' + (miss ? ' missing' : '') + '" data-card="' + esc(c.name) + '" aria-label="' + c.qty + ' ' + esc(canonical(c.name)) + (miss ? ', faltam ' + miss : ', completo') + '">' +
      (imgOf(info) ? '<img src="' + esc(imgOf(info)) + '" alt="" loading="lazy" decoding="async" width="488" height="680">'
        : '<span class="ph" style="' + phStyle(info) + '">' + esc(canonical(c.name)) + '</span>') +
      '<span class="cap" aria-hidden="true"><span>' + c.qty + '×</span>' + (miss ? '<span class="m">falta ' + miss + '</span>' : '<span class="k">✓</span>') + '</span></button></li>';
  }
  function deckGroups(d, board, onlyMissing) {
    var cards = d.cards.filter(function (c) { return c.board === board && !FU.isBasic(c.name) && (!onlyMissing || FU.missingOf(c)); });
    if (!cards.length) return [];
    var nameOf = function (c) { return c.name; }, qtyOf = function (c) { return c.qty; };
    if (board !== 'main') return [{ title: board === 'side' ? 'Sideboard' : 'Comandante', items: sortItems(cards, nameOf, qtyOf) }];
    return groupByType(cards, nameOf).map(function (g) { g.items = sortItems(g.items, nameOf, qtyOf); return g; });
  }

  /* ---------- barra de ferramentas e painéis (como no Moxfield) ---------- */
  var ICO = {
    exp: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
    sliders: svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
    chev: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>'
  };
  function toolsBar(buttons, ctx, right) {
    return '<div class="tools"><div class="row1"><div class="ic">' + buttons.join('') + '</div><div class="rt">' +
      '<button class="link" data-sheet="opts" data-ctx="' + esc(ctx) + '" aria-label="Opções de exibição">' + ICO.sliders + 'Exibição</button>' + (right || '') + '</div></div></div>';
  }
  function toolBtn(attrs, icon, label) {
    return '<button class="ib" ' + attrs + ' aria-label="' + esc(label) + '" title="' + esc(label) + '">' + icon + '</button>';
  }
  var TYPE_ICON = {
    'Criaturas': '<circle cx="5.5" cy="10" r="1.9"/><circle cx="9.5" cy="5.5" r="1.9"/><circle cx="14.5" cy="5.5" r="1.9"/><circle cx="18.5" cy="10" r="1.9"/><path d="M12 11.5c-2.6 0-5 3.3-5 5.8 0 1.8 1.4 2.7 2.8 2.7.9 0 1.5-.5 2.2-.5s1.3.5 2.2.5c1.4 0 2.8-.9 2.8-2.7 0-2.5-2.4-5.8-5-5.8z"/>',
    'Mágicas instantâneas': '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    'Feitiços': '<path d="M12 3c2 4 6 5 6 10a6 6 0 0 1-12 0c0-3 2-4 3-6 1 2 2 2 3 1-1-2 0-3 0-5z"/>',
    'Encantamentos': '<path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z"/>',
    'Artefatos': '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
    'Terrenos': '<path d="M3 19l6-10 4 6 3-4 5 8z"/>',
    'Planeswalkers': '<circle cx="12" cy="6" r="3"/><path d="M6 21v-3a6 6 0 0 1 12 0v3"/>',
    'Sideboard': '<rect x="4" y="5" width="12" height="15" rx="2"/><path d="M8 3h10a2 2 0 0 1 2 2v12"/>',
    'Comandante': '<path d="M4 18h16l-1-10-4 4-3-6-3 6-4-4z"/>',
    'Terrenos básicos': '<path d="M3 19l6-10 4 6 3-4 5 8z"/>'
  };
  function secHead(key, title, n, extra) {
    var closed = !!(state.ui.collapsed || {})[key];
    var ic = TYPE_ICON[title] || '<rect x="5" y="4" width="14" height="16" rx="2"/>';
    return '<h2 class="sec-h"><button class="sec-t" data-collapse="' + esc(key) + '" aria-expanded="' + !closed + '"><svg class="ti" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ic + '</svg>' + esc(title) +
      ' <span class="c">(' + n + ')</span>' + ICO.chev + '</button>' + (extra || '') + '</h2>';
  }
  function isClosed(key) { return !!(state.ui.collapsed || {})[key]; }

  var sheet = document.getElementById('sheet');
  var sheetBody = document.getElementById('sheetBody');
  var sheetCtx = null, sheetReturn = null;
  sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.close(); });
  sheet.addEventListener('close', function () { sheetCtx = null; if (sheetReturn && document.body.contains(sheetReturn)) sheetReturn.focus({ preventScroll: true }); });

  function segRow(label, key, opts, cur) {
    return '<fieldset class="field-set"><legend>' + label + '</legend><div class="seg2">' + opts.map(function (o) {
      return '<button type="button" data-set="' + key + '" data-val="' + esc(o[0]) + '" aria-pressed="' + (cur === o[0]) + '">' + esc(o[1]) + '</button>';
    }).join('') + '</div></fieldset>';
  }
  function openSheet(type, ctx, trigger) {
    if (trigger) sheetReturn = trigger;
    sheetCtx = { type: type, ctx: ctx };
    var ui = state.ui, html = '';
    if (type === 'opts') {
      html = '<h2 id="sheetTitle">Opções de exibição</h2>';
      if (ctx === 'falta') {
        var fl = formats();
        if (fl.length > 1) html += segRow('Formato', 'fmt', [['all', 'Todos']].concat(fl.map(function (f) { return [f, f]; })), ui.fmt && ui.fmt !== 'all' ? ui.fmt : 'all');
        var inF = state.decks.filter(function (d) { return !ui.fmt || ui.fmt === 'all' || fmtOf(d) === ui.fmt; });
        if (inF.length > 1) html += segRow('Deck', 'deck', [['all', ui.fmt && ui.fmt !== 'all' ? 'Todos de ' + ui.fmt : 'Todos']].concat(inF.map(function (d) { return [d.id, d.name]; })), ui.deck || 'all');
        html += segRow('Ver como', 'fview', [['grid', 'Imagens'], ['list', 'Lista']], ui.fview === 'list' ? 'list' : 'grid');
      } else if (ctx === 'colecao') {
        html += segRow('Ver como', 'dview', [['grid', 'Imagens'], ['list', 'Lista']], ui.view.colecao === 'list' ? 'list' : 'grid');
      } else {
        var v = ui.view[ctx] === 'list' ? 'list' : 'grid';
        html += segRow('Ver como', 'dview', [['grid', 'Imagens'], ['list', 'Lista']], v);
        html += segRow('Mostrar', 'onlyMiss', [['no', 'Todas'], ['yes', 'Só o que falta']], ui.onlyMiss ? 'yes' : 'no');
      }
      html += segRow('Ordenar por', 'sort', [['name', 'Nome'], ['price', 'Preço'], ['cmc', 'Custo']], ui.sort);
    } else if (type === 'export') {
      var miss = ctx === 'falta' ? missingAgg(scopeDecks()) : missingAgg([deckById(ctx)]);
      html = '<h2 id="sheetTitle">Exportar</h2><ul class="menu">' +
        '<li><button data-exp="liga"' + (miss.length ? '' : ' disabled') + '>' + svg('<path d="M6 6h15l-1.5 9h-12z"/><path d="M6 6 5 3H2"/><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/>') + '<span>Copiar o que falta para a Liga Magic<small>Formato do "Comprar por lista"</small></span></button></li>' +
        '<li><button data-exp="share"' + (miss.length ? '' : ' disabled') + '>' + ICON.share + '<span>Compartilhar o que falta<small>WhatsApp e outros apps</small></span></button></li>' +
        (ctx !== 'falta' ? '<li><button data-exp="full">' + ICON.copy + '<span>Copiar a lista completa do deck<small>Para colar no Moxfield, Archidekt ou Arena</small></span></button></li>' : '') +
        '</ul>';
    } else if (type === 'owned') {
      html = '<h2 id="sheetTitle">Marcar o que eu tenho</h2>' +
        '<p class="small muted" id="ownh">Cole a lista das cartas que você tem (ex.: 4 Counterspell). Sem número, marco todas as cópias. Só marco: não desmarco nada.</p>' +
        '<label for="ownIn" class="visually-hidden">Cartas que eu tenho</label><textarea id="ownIn" aria-describedby="ownh" spellcheck="false" autocapitalize="off" style="min-height:180px;margin-top:12px"></textarea>' +
        '<button class="btn primary full" data-ownapply style="margin-top:12px">Marcar no deck</button>';
    }
    else if (type === 'swap') { var sw = String(ctx).split('|'), sd = deckById(sw[0]), se = consEntry(sd, +sw[1], sw.slice(2).join('|')); html = se ? considerSwapSheet(sd, se) : '<p>Carta não encontrada.</p>'; }
    else if (type === 'consall') { var cad2 = deckById(ctx); html = cad2 ? consAllSheet(cad2) : '<p>Deck não encontrado.</p>'; }
    else if (type === 'consact') { var ca0 = String(ctx).split('|'), cad = deckById(ca0[0]), cae = consEntry(cad, +ca0[1], ca0.slice(2).join('|')); html = cae ? considerActionSheet(cad, cae) : '<p>Carta não encontrada.</p>'; }
    else if (type === 'guide') { guideDraft = null; var gd = deckById(ctx); html = gd ? guideInputHtml(gd) : '<p>Deck não encontrado.</p>'; }
    sheetBody.innerHTML = html;
    if (!sheet.open) sheet.showModal();
  }
  sheetBody.addEventListener('click', function (e) {
    var t = e.target.closest('button');
    if (!t || !sheetCtx) return;
    var ctx = sheetCtx.ctx;
    if (sheetCtx.type === 'consall') {
      if (t.hasAttribute('data-callno')) { sheet.close(); return; }
      if (!t.hasAttribute('data-callgo')) return;
      var cad = deckById(ctx), cl = cad ? consAllList(cad) : [];
      if (cl.length < 2) { toast('A lista mudou. Abra de novo.'); sheet.close(); return; }
      var cn = 0;
      cl.slice().reverse().forEach(function (x) { if (consToDeck(cad, x.i, x.e.name)) cn++; });
      persist(true); sheet.close();
      var ya = window.scrollY; render(); window.scrollTo(0, ya);
      var fca = document.getElementById('csH'); if (fca) fca.focus({ preventScroll: true });
      toast(cn + (cn === 1 ? ' carta entrou' : ' cartas entraram') + ' no deck.');
      return;
    }
    if (sheetCtx.type === 'consact') {
      var cp = String(ctx).split('|'), cdk = deckById(cp[0]), cnm = cp.slice(2).join('|');
      if (!cdk || !consEntry(cdk, +cp[1], cnm)) { toast('A lista mudou. Abra a carta de novo.'); sheet.close(); return; }
      if (t.hasAttribute('data-caswap')) { openSheet('swap', ctx, null); return; }
      var cdone = null;
      if (t.hasAttribute('data-cadeck')) { cdone = consToDeck(cdk, +cp[1], cnm); if (cdone) toast(cdone.name + ' entrou no ' + (cdone.board === 'side' ? 'sideboard' : 'deck') + '.'); }
      else if (t.hasAttribute('data-carm')) { cdone = consDrop(cdk, +cp[1], cnm); if (cdone) toast('Tirei ' + cdone.name + ' da lista.'); }
      else return;
      persist(true); sheet.close();
      var yc = window.scrollY; render(); window.scrollTo(0, yc);
      var fcn = document.getElementById('csH'); if (fcn) fcn.focus({ preventScroll: true });
      return;
    }
    if (sheetCtx.type === 'swap') {
      if (!t.hasAttribute('data-swout')) return;
      var sp = String(ctx).split('|'), sdk = deckById(sp[0]);
      if (!sdk) return;
      if (!consEntry(sdk, +sp[1], sp.slice(2).join('|'))) { toast('A lista mudou. Abra a troca de novo.'); sheet.close(); return; }
      var res = considerSwap(sdk, +sp[1], +t.getAttribute('data-swout'));
      if (!res) { toast('Não consegui trocar.'); return; }
      persist(true); sheet.close();
      var yw = window.scrollY; render(); window.scrollTo(0, yw);
      var fw = document.getElementById('csH'); if (fw) fw.focus({ preventScroll: true });
      toast('Entrou ' + res.inName + ', saiu ' + res.outName + '. A que saiu está em Em consideração.');
      return;
    }
    if (sheetCtx.type === 'guide') {
      var gdk = deckById(ctx);
      if (!gdk) return;
      if (t.hasAttribute('data-gcopy')) { copyText(guideCurrentPrompt(gdk), guideMu ? 'Pedido copiado. Cole na sua IA.' : 'Pedido copiado. Cole na sua IA e anexe o print.'); return; }
      if (t.hasAttribute('data-gai')) { openAi(AIS[0], guideCurrentPrompt(gdk), guideMu ? 'Pedido copiado. Se a IA abrir vazia, é só colar.' : 'Pedido copiado. Se a IA abrir vazia, é só colar e anexar o print.'); return; }
      if (t.hasAttribute('data-gcheck')) {
        var gin = document.getElementById('gIn'), gmsg = document.getElementById('gMsg');
        guideText = gin.value; gin.removeAttribute('aria-invalid');
        var bad = function (m) { gmsg.textContent = m; gin.setAttribute('aria-invalid', 'true'); gin.focus(); };
        if (!guideText.trim()) { bad('Cole primeiro a resposta da IA.'); return; }
        if (guideText.length > 100000) { bad('Texto grande demais. Cole só a resposta da IA, sem o resto da conversa.'); return; }
        var gp = FU.parseGuide(guideMu && !/adversari/i.test(guideText) && /^\s*(```\s*)?(entra|sai)\s*:/im.test(guideText) ? 'ADVERSARIO: ' + guideMu.r.o + '\n' + guideText : guideText), skipped = 0;
        if (gdk.format !== 'Premodern' && gp.guides.length) { skipped = gp.guides.length; gp.guides = []; }
        gp.skipped = skipped;
        if (!gp.primer && !gp.guides.length && !skipped) { bad(gp.errors.length ? gp.errors[0] : 'Não achei nenhum bloco no formato (ADVERSARIO, ENTRA, SAI, NOTAS). Peça à IA para devolver só o bloco, ou cole de novo.'); return; }
        guideDraft = gp; sheetBody.innerHTML = guidePreviewHtml(gdk, gp);
        var f1 = document.getElementById('sheetTitle'); if (f1) f1.focus();
        return;
      }
      if (t.hasAttribute('data-gback')) { sheetBody.innerHTML = guideInputHtml(gdk); var f2 = document.getElementById('gIn'); if (f2) f2.focus(); return; }
      if (t.hasAttribute('data-gsave')) {
        if (!guideDraft) return;
        guideSave(gdk, guideDraft); guideDraft = null; guideText = '';
        var saved = persist(true); sheet.close();
        var ys = window.scrollY; render(); window.scrollTo(0, ys);
        var fh = document.getElementById('pmH') || document.getElementById('ugH'); if (fh) fh.focus({ preventScroll: true });
        if (saved) toast('Guia salvo no deck.');
        return;
      }
    }
    if (t.hasAttribute('data-set')) {
      var k = t.getAttribute('data-set'), v = t.getAttribute('data-val');
      if (k === 'fmt') { state.ui.fmt = v; state.ui.deck = 'all'; }
      else if (k === 'deck') state.ui.deck = v;
      else if (k === 'fview') state.ui.fview = v;
      else if (k === 'dview') state.ui.view[ctx] = v;
      else if (k === 'onlyMiss') state.ui.onlyMiss = v === 'yes';
      else if (k === 'sort') state.ui.sort = v;
      else if (k === 'density') { state.ui.density = v; document.body.classList.toggle('compact', v === 'compact'); }
      persist(false);
      var y = window.scrollY; render(); window.scrollTo(0, y);
      openSheet(sheetCtx.type, ctx);
      var again = sheetBody.querySelector('[data-set="' + k + '"][data-val="' + (window.CSS && CSS.escape ? CSS.escape(v) : v) + '"]');
      if (again) again.focus();
      return;
    }
    if (t.hasAttribute('data-ownapply')) {
      var od = deckById(ctx), oin = document.getElementById('ownIn');
      if (!od) return;
      if (!oin.value.trim()) { toast('Cole a lista primeiro.'); oin.focus(); return; }
      var or = FU.markOwned(od.cards, oin.value, canonical);
      persist(true); sheet.close();
      var yo = window.scrollY; render(); window.scrollTo(0, yo);
      toast((or.changed ? 'Marquei ' + or.changed + (or.changed === 1 ? ' carta.' : ' cartas.') : 'Nada novo para marcar.') + (or.notFound.length ? ' ' + or.notFound.length + (or.notFound.length === 1 ? ' não está' : ' não estão') + ' neste deck.' : ''));
      return;
    }
    var scope = ctx === 'falta' ? (scopeDecks()) : [deckById(ctx)];
    var txt = FU.toLigaMagic(missingAgg(scope));
    var x = t.getAttribute('data-exp');
    if (x === 'liga') { copyText(txt, 'Copiado. Cole no "Comprar por lista" da Liga Magic.'); sheet.close(); }
    else if (x === 'share') { sheet.close(); shareText('O que me falta', 'Preciso destas cartas:\n' + txt); }
    else if (x === 'full') { copyText(FU.toText(deckById(ctx).cards), 'Lista completa copiada.'); sheet.close(); }
  });

  /* Decks que entram na conta: filtra por formato e, se escolhido, por um deck só. */
  function fmtOf(d) { return d.format || 'Sem formato'; }
  function formats() {
    var seen = [];
    state.decks.forEach(function (d) { if (seen.indexOf(fmtOf(d)) === -1) seen.push(fmtOf(d)); });
    var order = ['Premodern', 'Commander', 'Pauper', 'Legacy', 'Modern', 'Outro', 'Sem formato', 'Lista'];
    return seen.sort(function (a, b) { var ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b); });
  }
  function scopeDecks() {
    var ui = state.ui;
    if (ui.fmt && ui.fmt !== 'all' && formats().indexOf(ui.fmt) === -1) ui.fmt = 'all';
    var ds = state.decks.filter(function (d) { return !ui.fmt || ui.fmt === 'all' || fmtOf(d) === ui.fmt; });
    if (ui.deck && ui.deck !== 'all') {
      var one = deckById(ui.deck);
      if (one && ds.indexOf(one) !== -1) return [one];
      ui.deck = 'all';
    }
    return ds;
  }
  function scopeLabel() {
    var ui = state.ui;
    if (ui.deck && ui.deck !== 'all' && deckById(ui.deck)) return deckById(ui.deck).name;
    if (ui.fmt && ui.fmt !== 'all') return ui.fmt;
    return '';
  }
  function heroArt() {
    var list = scopeDecks();
    for (var i = 0; i < list.length; i++) { var f = featured(list[i]); if (f) return artOf(f); }
    return null;
  }
  /* Faixa da home: troca sozinha entre as cartas-símbolo dos decks (as que "fazem o deck ser o deck" e as mais caras).
     Só troca com internet e sem "reduzir movimento"; sem internet, fica na carta atual. */
  var heroTimer = null, heroList = [], heroAt = 0;
  function heroHtml() {
    heroList = FU.heroPool(scopeDecks(), cardInfo, unitUsd, 12);
    var a = null, cap = '';
    if (heroList.length) { heroAt = Math.floor(Math.random() * heroList.length); a = heroList[heroAt].art; cap = heroList[heroAt].name + ' · ' + heroList[heroAt].deck; }
    else a = heroArt();
    return '<section class="hero">' + (a ? '<img class="art on" id="heroA" src="' + esc(a) + '" alt="" decoding="async">' : '') + '<img class="art" id="heroB" alt="" decoding="async">' + '<span class="shade" aria-hidden="true"></span>' +
      '<div class="info"><p class="wordmark"><img src="icons/icon-192.png" alt="" width="40" height="40">Playset</p>' +
      '<p class="tagline">A wantlist dos seus decks</p>' + (cap ? '<p class="hero-cap" id="heroCap">Arte: ' + esc(cap) + '</p>' : '') + '</div></section>';
  }
  function heroStep() {
    var a = document.getElementById('heroA'), b = document.getElementById('heroB');
    if (!a || !b || heroList.length < 2) { clearInterval(heroTimer); heroTimer = null; return; }
    if (!navigator.onLine) return;
    var next = (heroAt + 1) % heroList.length, h = heroList[next], front = b.classList.contains('on') ? b : a, back = front === a ? b : a;
    back.onload = function () {
      back.onload = null; heroAt = next; back.classList.add('on'); front.classList.remove('on');
      var cap = document.getElementById('heroCap'); if (cap) cap.textContent = 'Arte: ' + h.name + ' · ' + h.deck;
    };
    back.onerror = function () { back.onerror = null; heroAt = next; };
    back.src = h.art;
  }
  function heroStart() {
    clearInterval(heroTimer); heroTimer = null;
    if (!document.getElementById('heroB') || heroList.length < 2) return;
    var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!calm) heroTimer = setInterval(heroStep, 12000);
  }
  function viewFalta() {
    var ui = state.ui;
    if (ui.deck !== 'all' && !deckById(ui.deck)) ui.deck = 'all';
    var items = missingAgg(scopeDecks());
    var totalCards = 0, totalBrl = 0;
    items.forEach(function (i) {
      totalCards += i.total;
      var b = unitBrl(cardInfo(i.name));
      if (b != null) totalBrl += b * i.total;
    });
    fab.innerHTML = '';
    barAction.innerHTML = '';
    if (!state.decks.length) {
      return heroHtml() + '<div class="card empty stack"><h1 style="font-size:1.5rem">O que me falta</h1>' +
        '<p class="muted">Cole a lista de um deck e eu somo tudo o que falta, carta por carta, com preço salvo para ver sem internet.</p>' +
        '<a class="btn primary full" href="#/novo">' + ICON.plus + 'Adicionar deck</a>' +
        '<button class="btn full" data-act="example">Ver com decks de exemplo</button></div>' + addCardHtml({ id: SOLTAS_ID }, true);
    }
    var scopeName = scopeLabel();
    var html = heroHtml() + '<header class="head compact"><h1 class="visually-hidden">O que me falta' + (scopeName ? ': ' + esc(scopeName) : '') + '</h1>' +
      '<p class="statline">' + (scopeName ? '<span class="badge scope">' + esc(scopeName) + '</span>' : '') + '<span class="badge">' + totalCards + (totalCards === 1 ? ' carta' : ' cartas') + '</span>' + (totalBrl ? '<span class="badge">≈ ' + brl0.format(totalBrl) + '</span>' : '') +
      '<span class="updated">' + priceStatus() + '</span></p></header>' +
      toolsBar([
        toolBtn('data-buy="falta"' + (items.length ? '' : ' disabled'), svg('<path d="M6 6h15l-1.5 9h-12z"/><path d="M6 6 5 3H2"/><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/>'), 'Comprar: copiar o que falta para a Liga Magic'),
        toolBtn('data-sheet="export" data-ctx="falta"' + (items.length ? '' : ' disabled'), ICO.exp, 'Exportar'),
        toolBtn('data-act="refresh"', ICON.refresh, 'Atualizar preços')
      ], 'falta');

    if (!items.length) return html + '<div class="card empty"><p><strong>Nada faltando aqui.</strong></p></div>' + addCardHtml({ id: SOLTAS_ID }, true);
    var grid = ui.fview !== 'list';
    groupByType(items, function (i) { return i.name; }).forEach(function (g) {
      sortItems(g.items, function (i) { return i.name; }, function (i) { return i.total; });
      var n = 0, v = 0;
      g.items.forEach(function (i) { n += i.total; var b = unitBrl(cardInfo(i.name)); if (b != null) v += b * i.total; });
      var key = 'f:' + g.title;
      html += '<section class="sec">' + secHead(key, g.title, n, v ? '<span class="sum">' + brl0.format(v) + '</span>' : '');
      if (isClosed(key)) { html += '</section>'; return; }
      if (grid) {
        html += '<ul class="grid">' + g.items.map(function (i) {
          var info = cardInfo(i.name);
          var pr = moneyShort(info, 1);
          return '<li><button class="gc" data-card="' + esc(i.name) + '" aria-label="Faltam ' + i.total + ' ' + esc(i.name) + (i.maybe ? ', ' + (i.maybe === i.total ? 'em consideração' : i.maybe + ' em consideração') : '') + (pr ? ', ' + pr + ' cada' : '') + '">' +
            (imgOf(info) ? '<img src="' + esc(imgOf(info)) + '" alt="" loading="lazy" decoding="async" width="488" height="680">' : '<span class="ph" style="' + phStyle(info) + '">' + esc(i.name) + '</span>') +
            '<span class="cap" aria-hidden="true"><span class="m">falta ' + i.total + (i.maybe ? ' · talvez' : '') + '</span><span>' + (pr || '—') + '</span></span></button></li>';
        }).join('') + '</ul></section>';
        return;
      }
      html += '<ul class="rows">';
      g.items.forEach(function (i) {
        var info = cardInfo(i.name);
        html += '<li class="r"><span class="q miss" aria-label="faltam ' + i.total + '">' + i.total + '</span>' +
          '<button class="nm" data-card="' + esc(i.name) + '">' + esc(i.name) + (i.maybe ? '<span class="d">' + (i.maybe === i.total ? 'em consideração' : i.maybe + ' em consideração') + '</span>' : '') +
          (state.decks.length > 1 && ui.deck === 'all' ? '<span class="d">' + i.decks.map(function (d) { return esc(d.deckName) + (i.decks.length > 1 ? ' ' + d.qty : ''); }).join(' · ') + '</span>' : '') + '</button>' +
          rowTools(info, i.name) + priceCell(info, i.total) + '</li>';
      });
      html += '</ul></section>';
    });
    return html + addCardHtml({ id: SOLTAS_ID }, true) + '<p class="foot">Terrenos básicos não entram. “Talvez” e “em consideração” são cartas da lista Em consideração de um deck. Preço: o que você anotou da Liga Magic ou a edição mais barata no Scryfall, convertida para real.</p>';
  }

  function viewDeck(id) {
    var d = deckById(id);
    fab.innerHTML = '';
    barAction.innerHTML = '';
    if (!d) return '<div class="card empty stack"><p>Deck não encontrado.</p><a class="btn" href="#/decks">Voltar para Decks</a></div>';
    var p = FU.deckProgress(d);
    var miss = p.need - p.have;
    var f = featured(d);
    var hasPlay = d.format !== 'Lista';
    var tab = hasPlay && state.ui.view[d.id + ':tab'] === 'play' ? 'play' : 'deck';
    var view = state.ui.view[d.id] === 'list' ? 'list' : 'grid';
    var onlyMiss = !!state.ui.onlyMiss;
    var basics = d.cards.filter(function (c) { return FU.isBasic(c.name); });
    var total = d.cards.filter(function (c) { return c.board !== 'side'; }).reduce(function (s, c) { return s + c.qty; }, 0);
    var missV = deckValue(d, true);

    var html = '<section class="banner" style="' + (f ? '' : phStyle({ colors: deckColors(d) })) + '">' +
      (f ? '<img class="art" src="' + esc(artOf(f)) + '" alt="" decoding="async">' : '') + '<span class="shade"></span>' +
      '<div class="info"><div class="toprow"><a href="#/decks" class="back" data-goback>' + ICON.back + 'Voltar</a>' +
        (d.format === 'Lista' ? '' : '<button class="pinbtn" data-pin="' + esc(d.id) + '" aria-pressed="' + (d.pinned ? 'true' : 'false') + '">' + ICO.pin + (d.pinned ? 'Fixado' : 'Fixar') + '</button>') + '</div>' +
      '<h1>' + esc(d.name) + '</h1>' +
      '<p style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="badge">' + esc(d.format || 'Sem formato') + '</span>' + pipsHtml(deckColors(d)) + (FU.deckComplete(d) ? '<span class="seal ok on-art">' + ICO.check + 'Completo</span>' : '') + '</p>' +
      (d.cards.length ? '<p class="metaline"><span><strong>' + p.pct + '%</strong> pronto</span><span>' + total + ' cartas</span>' +
        (miss ? '<span>faltam <strong>' + miss + '</strong>' + (missV ? ' · ≈ ' + brl0.format(missV) : '') + '</span>' : '<span>completo</span>') + '</p>' +
        '<div class="meter" aria-hidden="true"><span style="width:' + p.pct + '%"></span></div>' : '<p class="metaline"><span>' + (d.format === 'Lista' ? 'Sem cartas ainda. Busque abaixo.' : 'Sem cartas ainda. Junte fontes em “Em consideração”.') + '</span></p>') +
      '<p class="updated">Atualizado ' + esc(ago(state.changedAt || d.createdAt) || '') + '</p></div></section>' +
      (hasPlay ? '<div class="tabsbar" role="tablist" aria-label="Seções do deck">' +
      '<button role="tab" data-dtab="deck" aria-selected="' + (tab === 'deck') + '">Lista</button>' +
      '<button role="tab" data-dtab="play" aria-selected="' + (tab === 'play') + '">Como jogar</button></div>' : '');

    if (tab === 'play') return html + primerHtml(d) + matchupCard(d);
    if (!d.cards.length) {
      if (d.format === 'Lista') return html + '<div class="card pad stack" style="margin:16px"><p><strong>Lista vazia.</strong></p><p class="muted small">Busque uma carta abaixo, ou abra qualquer carta do app e toque em "Adicionar a um deck ou lista".</p></div>' + addCardHtml(d);
      if (FU.considerSync(d, canonical, 12)) persist(true);
      return html + '<div class="card pad stack" style="margin:16px"><p><strong>Seu deck ainda não tem cartas.</strong></p><p class="muted small">Junte listas de referência em “Em consideração” e escolha o que entra, busque cartas abaixo, ou edite o deck e cole uma lista.</p></div>' + considerHtml(d);
    }
    html += toolsBar([
      toolBtn('data-sheet="export" data-ctx="' + esc(d.id) + '"', ICO.exp, 'Exportar'),
      toolBtn('data-sheet="owned" data-ctx="' + esc(d.id) + '"', svg('<path d="M9 11l3 3 8-8"/><path d="M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11"/>'), 'Marcar o que eu tenho colando uma lista'),
      toolBtn('data-photo="' + esc(d.id) + '"', ICO.cam, 'Importar por foto'),
      toolBtn('data-buy="' + esc(d.id) + '"' + (miss || consNeedOf(d) ? '' : ' disabled'), svg('<path d="M6 6h15l-1.5 9h-12z"/><path d="M6 6 5 3H2"/><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/>'), 'Comprar: copiar o que falta para a Liga Magic')
    ], d.id, '<a class="ib" href="#/editar/' + esc(d.id) + '" aria-label="Editar deck" title="Editar deck" style="color:var(--accent)">' + ICON.edit + '</a>');
    if (onlyMiss) html += '<p class="chipline"><span>Mostrando só o que falta</span><button class="link" data-clearmiss>Mostrar todas</button></p>';

    var sections = '';
    ['commander', 'main', 'side'].forEach(function (b) {
      deckGroups(d, b, onlyMiss).forEach(function (g) {
        var n = g.items.reduce(function (s, c) { return s + c.qty; }, 0);
        var key = 'd:' + g.title;
        sections += '<section class="sec">' + secHead(key, g.title, n);
        if (!isClosed(key)) {
          sections += view === 'grid' ? '<ul class="grid">' + g.items.map(function (c) { return gridCard(d, c); }).join('') + '</ul>'
            : '<ul class="rows">' + g.items.map(function (c) { return deckRow(d, c); }).join('') + '</ul>';
        }
        sections += '</section>';
      });
    });
    if (!sections && onlyMiss) sections = '<div class="card empty"><p><strong>Deck completo.</strong> Não falta nada.</p></div>';
    html += sections;
    if (basics.length && !onlyMiss) {
      var bk = 'd:Terrenos básicos';
      html += '<section class="sec">' + secHead(bk, 'Terrenos básicos', basics.reduce(function (s, c) { return s + c.qty; }, 0), '<span class="sum">não contam</span>') +
        (isClosed(bk) ? '' : '<ul class="rows">' + basics.map(function (c) { return '<li class="r"><span class="q">' + c.qty + '</span><span class="nm" style="cursor:default">' + esc(c.name) + (c.board === 'side' ? ' (side)' : '') + '</span><span></span><span></span></li>'; }).join('') + '</ul>') + '</section>';
    }
    if (FU.considerSync(d, canonical, 12)) persist(true);
    html += considerHtml(d);
    if (d.format === 'Lista') html += addCardHtml(d);
    html += '<p class="foot">' + (view === 'list' ? 'Toque no marcador à direita para dizer que tem todas (ou nenhuma). ' : '') + 'Toque numa carta para mudar a quantidade, mover para o sideboard, tirar do deck ou ajustar quantas você tem.</p>';
    return html;
  }
  /* Lista "Soltas": cartas avulsas que a pessoa quer, sem deck. Criada sozinha na primeira carta. */
  var SOLTAS_ID = 'soltas';
  function soltasDeck(create) {
    var d = deckById(SOLTAS_ID);
    if (!d && create) {
      d = { id: SOLTAS_ID, name: 'Soltas', format: 'Lista', loose: true, cards: [], createdAt: Date.now() };
      state.decks.push(d);
    }
    return d;
  }
  /* Campo "Adicionar carta": no fim de cada deck/lista, da tela inicial (vai para Soltas) e da Coleção. */
  function addCardHtml(d, mode) {
    var kind = mode === true ? 'soltas' : mode;
    var title = kind === 'soltas' ? 'Adicionar carta solta' : (kind === 'colecao' ? 'Adicionar à coleção' : 'Adicionar carta');
    var help = kind === 'soltas'
      ? 'A carta vai para a lista “Soltas” e entra em “O que falta”. Depois você pode movê-la para um deck.'
      : (kind === 'colecao' ? 'Marca 1 cópia como sua, fora de qualquer deck. Para várias de uma vez, importe uma foto.'
        : 'Entra 1 cópia no principal. Depois toque na carta para ajustar.');
    var seg = '';
    return '<section class="sec addcard" aria-labelledby="acL"><h2 class="sec-h" id="acL">' + title + '</h2><div class="form" style="padding-top:8px;gap:8px">' + seg +
      '<label for="acIn" class="visually-hidden">Nome da carta</label>' +
      '<div class="acrow"><input type="text" id="acIn" data-acdeck="' + esc(d.id) + '" autocomplete="off" spellcheck="false" autocapitalize="off" enterkeyhint="search" placeholder="Nome da carta (inglês ou português)" aria-describedby="acHelp" aria-controls="acList">' +
      '<button type="button" class="btn primary" data-acgo>' + ICON.plus + 'Adicionar</button></div>' +
      '<p class="xs muted" id="acHelp">' + help + '</p>' +
      '<p class="visually-hidden" id="acLive" aria-live="polite"></p><ul class="aclist" id="acList"></ul></div></section>';
  }
  var acTimer = null, acSeq = 0;
  function acLocal(q) {
    var k = FU.norm(q), out = [], seen = {};
    var names = Object.keys(db.cards).map(function (x) { return db.cards[x]; }).filter(function (c) { return !c.notFound; }).map(function (c) { return c.name; });
    names.forEach(function (n) { var nk = FU.norm(n); if (!seen[nk] && nk.indexOf(k) !== -1) { seen[nk] = 1; out.push(n); } });
    return out.sort(function (a, b) { return (FU.norm(a).indexOf(k) - FU.norm(b).indexOf(k)) || a.localeCompare(b); }).slice(0, 8);
  }
  /* list: nomes (texto) ou { name, label, sub }. status: '' | 'loading' */
  function acShow(list, q, status) {
    var ul = document.getElementById('acList'), live = document.getElementById('acLive');
    if (!ul) return;
    var items = list.map(function (n) { return typeof n === 'string' ? { name: n, label: n } : n; });
    var html = items.map(function (o) {
      return '<li><button type="button" class="acopt" data-acadd="' + esc(o.name) + '">' + ICON.plus +
        '<span class="acn">' + esc(o.label) + (o.sub ? '<small>' + esc(o.sub) + '</small>' : '') + '</span><span class="acgo">Adicionar</span></button></li>';
    }).join('');
    if (!items.length && q) {
      html = status === 'loading'
        ? '<li class="acnone" role="status">Buscando…</li>'
        : '<li class="acnone" role="status">Nenhuma carta encontrada para “' + esc(q) + '”.<small>Confira a grafia. Dá para digitar só parte do nome, em inglês ou em português.</small></li>';
    }
    ul.innerHTML = html;
    if (live) live.textContent = !q ? '' : (items.length ? items.length + (items.length === 1 ? ' sugestão' : ' sugestões') : (status === 'loading' ? 'Buscando' : 'Nenhuma carta encontrada'));
  }
  var AC_STOP = { de: 1, da: 1, do: 1, das: 1, dos: 1, e: 1, a: 1, o: 1, the: 1, of: 1 };
  function acGet(url) {
    return fetch(SCRY + url, { headers: { 'Accept': 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  /* Busca pelo nome impresso em português (ex.: "Vingança de Akroma"). Devolve o nome em inglês para adicionar. */
  function acPortuguese(q) {
    var words = FU.norm(q).split(' ').filter(function (w) { return w.length > 1 && !AC_STOP[w]; });
    if (!words.length) return Promise.resolve([]);
    words = words.map(function (w) { return w.replace(/[^a-z0-9']/g, ''); }).filter(Boolean);
    if (!words.length) return Promise.resolve([]);
    var query = 'lang:pt ' + words.join(' ');
    return acGet('/cards/search?include_multilingual=true&order=name&q=' + encodeURIComponent(query)).then(function (j) {
      var seen = {}, out = [];
      ((j && j.data) || []).forEach(function (c) {
        if (seen[c.name]) return;
        seen[c.name] = 1;
        var pt = c.printed_name || (c.card_faces && c.card_faces[0] && c.card_faces[0].printed_name);
        out.push({ name: c.name, label: pt && pt !== c.name ? pt : c.name, sub: pt && pt !== c.name ? c.name : '' });
      });
      return out.slice(0, 10);
    });
  }
  /* Última tentativa: nome aproximado (corrige erro de digitação). */
  function acFuzzy(q) {
    return acGet('/cards/named?fuzzy=' + encodeURIComponent(q)).then(function (c) {
      return c && c.object === 'card' ? [{ name: c.name, label: c.name }] : [];
    });
  }
  function acSearch(q) {
    q = q.trim();
    var seq = ++acSeq;
    document.getElementById('toast').classList.remove('show');
    if (q.length < 2) { acShow([], ''); return; }
    var local = acLocal(q);
    var online = navigator.onLine;
    acShow(local, q, online ? 'loading' : '');
    if (!online) return;
    var done = function (list) { if (seq === acSeq) acShow(list, q, ''); };
    acGet('/cards/autocomplete?q=' + encodeURIComponent(q)).then(function (j) {
      if (seq !== acSeq) return;
      var seen = {}, merged = [];
      local.concat((j && j.data) || []).forEach(function (n) { var nk = FU.norm(n); if (!seen[nk]) { seen[nk] = 1; merged.push(n); } });
      if (merged.length) return done(merged.slice(0, 10));
      return acPortuguese(q).then(function (pt) {
        if (pt.length) return done(pt);
        return acFuzzy(q).then(done);
      });
    });
  }
  function acAdd(name) {
    var inp = document.getElementById('acIn');
    if (!inp || !name) return;
    var did = inp.getAttribute('data-acdeck');
    if (did === 'colecao') {
      var cn = canonical(name);
      putSpare(cn, 1, []);
      persist(true);
      var yc = window.scrollY; render(); window.scrollTo(0, yc);
      var ac2 = document.getElementById('acIn'); if (ac2) ac2.focus({ preventScroll: true });
      toast('Na coleção: ' + cn + ' (' + spareQty(cn) + ' fora dos decks).');
      var ci = cardInfo(cn);
      if (!ci || !ci.typeLine) refreshPrices({ only: [cn], silent: true });
      return;
    }
    var loose = did === SOLTAS_ID;
    var d = loose ? soltasDeck(true) : deckById(did);
    if (!d) return;
    var nm = canonical(name);
    if (!loose && inp.getAttribute('data-acmode') === 'consider' && d.format !== 'Lista') {
      if (d.cards.some(function (c) { return FU.key(canonical(c.name)) === FU.key(nm); })) { toast('Já está no deck. Para mudar a quantidade, toque na carta.'); return; }
      FU.considerAdd(d, nm, 1, 'main', canonical);
      d.consNo = (d.consNo || []).filter(function (n) { return FU.key(n) !== FU.key(nm); });
      persist(true);
      var yq = window.scrollY; render(); window.scrollTo(0, yq);
      var aq = document.getElementById('acIn'); if (aq) aq.focus({ preventScroll: true });
      toast('Em consideração: ' + nm + '.');
      var iq = cardInfo(nm);
      if (!iq || !iq.typeLine) refreshPrices({ only: [nm], silent: true });
      return;
    }
    var ex = d.cards.filter(function (c) { return c.board === 'main' && FU.key(canonical(c.name)) === FU.key(nm); })[0];
    if (ex && !loose) { toast('Já está no deck. Toque na carta para mudar a quantidade.'); return; }
    var msg;
    if (ex) { setQty(ex, ex.qty + 1); msg = 'Agora são ' + ex.qty + ' de ' + nm + ' em Soltas.'; }
    else { addToDeck(d, nm, 1, 'main'); msg = loose ? 'Adicionada a Soltas: ' + nm + '.' : 'Adicionada: ' + nm + '.'; }
    if (loose && scopeDecks().indexOf(d) === -1) { state.ui.fmt = 'all'; state.ui.deck = 'all'; msg += ' Mostrando todos os decks.'; }
    persist(true);
    var y = window.scrollY; render(); window.scrollTo(0, y);
    var again = document.getElementById('acIn'); if (again) again.focus({ preventScroll: true });
    toast(msg);
    var i = cardInfo(nm);
    if (!i || !i.typeLine) refreshPrices({ only: [nm], silent: true });
  }
  /* Botão "Adicionar": usa a primeira sugestão da lista. */
  function acGo() {
    var inp = document.getElementById('acIn');
    if (!inp) return;
    if (inp.value.trim().length < 2) { toast('Digite o nome da carta.'); inp.focus(); return; }
    var first = document.querySelector('#acList [data-acadd]');
    if (first) { acAdd(first.getAttribute('data-acadd')); return; }
    if (!navigator.onLine) { toast('Sem internet: só acho cartas que o app já conhece.'); return; }
    toast('Ainda não achei essa carta. Confira a grafia.');
  }

  function viewForm(id, asList) {
    var d = id ? deckById(id) : null;
    barAction.innerHTML = ''; fab.innerHTML = '';
    if (id && !d) return '<div class="card empty"><p>Deck não encontrado.</p></div>';
    var isList = d ? d.format === 'Lista' : !!asList;
    var formats = [['Premodern', 'Premodern'], ['Commander', 'Commander'], ['Pauper', 'Pauper'], ['Legacy', 'Legacy'], ['Modern', 'Modern'], ['Outro', 'Outro'], ['Lista', 'Lista de cartas avulsas']];
    var cur = d ? d.format : (isList ? 'Lista' : 'Premodern');
    return '<header class="head"><a href="' + (d ? '#/deck/' + esc(d.id) : '#/decks') + '" class="link" style="margin-left:-4px" data-goback>' + ICON.back + 'Voltar' + '</a>' +
      '<h1>' + (d ? (isList ? 'Editar lista' : 'Editar deck') : (isList ? 'Nova lista' : 'Adicionar deck')) + '</h1></header>' +
      '<form id="deckForm" class="form" novalidate data-id="' + (d ? esc(d.id) : '') + '">' +
      '<div><label for="dn">Nome</label><input type="text" id="dn" autocomplete="off" required placeholder="' + (isList ? 'Ex.: Avulsas, Upgrades do Commander' : 'Ex.: UG Madness') + '" value="' + (d ? esc(d.name) : '') + '"></div>' +
      '<div><label for="df">Tipo</label><select id="df" class="field">' + formats.map(function (f) { return '<option value="' + f[0] + '"' + (cur === f[0] ? ' selected' : '') + '>' + f[1] + '</option>'; }).join('') + '</select></div>' +
      '<div><label for="dl">Lista <span class="muted">(opcional: dá para juntar fontes depois)</span></label><p class="small muted" id="dlh" style="margin:0 0 8px">Cole do Moxfield, Archidekt, MTG Goldfish, Arena ou WhatsApp. Uma carta por linha, ex.: 4 Counterspell. Sideboard depois de uma linha "Sideboard".' + (d ? ' O que você já marcou como "tenho" continua marcado.' : '') + '</p>' +
      '<textarea id="dl" aria-describedby="dlh" spellcheck="false" autocapitalize="off">' + (d ? esc(FU.toText(d.cards)) : '') + '</textarea></div>' +
      '<div class="chk"><input type="checkbox" id="dm"' + (state.ui.markAll === false ? '' : ' checked') + '><label for="dm">Marcar todas as cartas da lista como "tenho"</label></div>' +
      '<p class="small muted" style="margin:-4px 0 0">Só marca, nunca desmarca. Desligue se colar a lista de outra pessoa.</p>' +
      '<button class="btn full" type="button" data-photo="' + (d ? esc(d.id) : 'novo') + '">' + ICO.cam + 'Importar por foto em vez de colar</button>' +
      '<p id="formErr" class="err" role="alert"></p>' +
      '<button class="btn primary full" type="submit">' + (d ? 'Salvar alterações' : 'Salvar deck') + '</button>' +
      (d ? '<button class="btn full" type="button" data-act="deleteDeck" data-id="' + esc(d.id) + '" style="color:var(--miss);border-color:var(--miss)">Excluir ' + (isList ? 'lista' : 'deck') + '</button>' : '') +
      '</form>';
  }

  function ligaSectionHtml() {
    var cv = ligaCoverage();
    return '<section class="card pad stack" aria-labelledby="lg"><h3 id="lg" style="font-size:1.0625rem">Preços da Liga Magic (Brasil)</h3>' +
      '<p class="muted small">Tire print da página da carta na Liga e a sua IA lê os valores: menor, médio e maior. Ficam salvos no aparelho, sem internet, com a data.</p>' +
      '<p class="small"><strong>' + cv.have + ' de ' + cv.total + '</strong> cartas com preço da Liga' + (cv.last ? ' · último em ' + esc(fmtDate(cv.last)) : '') + '</p>' +
      '<a class="btn primary full" href="#/precos">Importar preços por print</a></section>';
  }
  /* Atualizar tudo: preços e cartas, winrates e backup na nuvem, em sequência. Cada etapa diz se deu certo. */
  var updBusy = false, updReport = null;
  function updAll() {
    if (updBusy) return;
    if (!navigator.onLine) { updReport = { rows: [{ ok: false, t: 'Sem internet. Nada foi atualizado; seus dados salvos continuam valendo.' }] }; render(); return; }
    updBusy = true; updReport = { rows: [], running: true }; render();
    var rows = updReport.rows, before = db.updatedAt || 0, hasCards = allNames().length > 0;
    function step() { render(); }
    refreshPrices({ silent: true }).then(function () {
      if (!hasCards) rows.push({ ok: null, t: 'Ainda não há cartas nos decks para atualizar preços.' });
      else rows.push((db.updatedAt || 0) > before ? { ok: true, t: 'preços e dados das cartas.' } : { ok: false, t: 'não consegui falar com o Scryfall. Mantive os preços salvos.' });
      step();
      return metaFetch(true);
    }).then(function (okMeta) {
      rows.push(okMeta ? { ok: true, t: 'winrates dos confrontos.' } : { ok: false, t: 'não consegui os winrates do servidor. Mantive os que você já tem.' });
      step();
      var sy = loadSync(), atBefore = sy.at;
      if (!sy.key) { rows.push({ ok: null, t: 'o backup automático não está ativado. Use o backup manual, mais abaixo.' }); return null; }
      if (!state.decks.length) { rows.push({ ok: null, t: 'não há decks para salvar na nuvem.' }); return null; }
      return pushSync(false).then(function () {
        var sy2 = loadSync();
        rows.push(sy2.at && sy2.at !== atBefore ? { ok: true, t: 'backup salvo na nuvem em ' + hhmm(sy2.at) + '.' } : { ok: false, t: 'não consegui salvar o backup na nuvem agora.' });
      });
    }).then(function () {
      var cv = ligaCoverage();
      if (cv.total && cv.have < cv.total) rows.push({ ok: null, t: 'preços da Liga em ' + cv.have + ' de ' + cv.total + ' cartas. Esses precisam de print, não dá para baixar sozinho.', link: '#/precos' });
      else if (cv.total) rows.push({ ok: true, t: 'todas as ' + cv.total + ' cartas já têm preço da Liga.' });
    }).catch(function () {
      rows.push({ ok: false, t: 'algo falhou no meio do caminho. Tente de novo.' });
    }).then(function () {
      updBusy = false; if (updReport) updReport.running = false; render();
    });
  }
  function viewMais() {
    barAction.innerHTML = ''; fab.innerHTML = '';
    var nag = needsBackup();
    var rep = updReport, rh = '';
    if (rep) {
      rh = '<ul class="upd-rows" style="list-style:none;padding:0;margin:0;display:grid;gap:8px">' + rep.rows.map(function (r) {
        return '<li class="small"><strong>' + (r.ok === true ? 'Feito: ' : (r.ok === false ? 'Não deu: ' : 'Atenção: ')) + '</strong>' + esc(r.t) + (r.link ? ' <a href="' + r.link + '" style="display:inline-block;min-height:44px;line-height:44px">Importar por print</a>' : '') + '</li>';
      }).join('') + '</ul>' + (rep.running ? '<p class="small"><strong>Atualizando… pode levar alguns segundos.</strong></p>' : '');
    }
    var gPrices = ('<h2 class="sec-h" style="padding:12px 0 0">Atualizar</h2>' +
      '<section class="card pad stack" aria-labelledby="pr"><h3 id="pr" style="font-size:1.0625rem">Atualizar informações do app</h3>' +
      '<p class="muted small">Um toque faz tudo: preços e dados das cartas, winrates dos confrontos e o backup na nuvem. Faça antes de ir à loja ou ao torneio: depois funciona sem internet.</p>' +
      '<p class="small">Última atualização de preços: <strong>' + (fmtDate(db.updatedAt) || 'nenhuma') + '</strong>' + (db.rate ? ' · US$ 1 = ' + brl.format(db.rate.brl) : '') + '</p>' +
      '<button class="btn primary full" data-act="updall"' + (updBusy ? ' disabled aria-disabled="true"' : '') + ' aria-busy="' + (updBusy ? 'true' : 'false') + '">' + ICON.refresh + (updBusy ? 'Atualizando…' : 'Atualizar tudo') + '</button>' +
      '<div id="updOut" role="status" aria-live="polite">' + rh + '</div>' +
      '<p class="xs muted">Preço automático: Scryfall, em dólar. É só uma noção; vale o da Liga Magic, abaixo.</p></section>' +
      ligaSectionHtml());
    var gTools = ('<h2 class="sec-h" style="padding:12px 0 0">Ferramentas</h2>' +
      '<section class="card pad stack" aria-labelledby="fr"><h3 id="fr" style="font-size:1.0625rem">Lista de um amigo</h3>' +
      '<p class="muted small">Cole a lista que ele mandou. Eu mostro quais dessas cartas você marcou que tem, nos decks, nas listas ou guardadas.</p>' +
      '<label for="fl" class="visually-hidden">Lista do amigo</label><textarea id="fl" spellcheck="false" autocapitalize="off" style="min-height:140px" placeholder="4 Counterspell&#10;2 Wild Mongrel"></textarea>' +
      '<button class="btn full" data-act="friend">Ver o que eu tenho</button></section><div id="friendOut" aria-live="polite"></div>');
    var gBackup = ('<h2 class="sec-h" style="padding:12px 0 0">Backup</h2>' +
      syncSectionHtml() +
      '<section class="card pad stack" aria-labelledby="bk"><h3 id="bk" style="font-size:1.0625rem">Backup dos seus decks</h3>' +
      (nag ? '<p class="small" style="color:var(--miss);font-weight:700">' + (state.lastBackup ? 'Seu último backup está desatualizado.' : 'Você ainda não fez backup.') + '</p>' : '') +
      '<p class="muted small">Guarda seus decks e o que você marcou como \"tenho\" fora do celular. Toque em \"Enviar backup\" e escolha o WhatsApp. Mande para você mesmo (a conversa com o seu próprio número). Vai um arquivo com as instruções de como voltar. Não apague. Para voltar: segure o arquivo no WhatsApp, toque em Compartilhar e escolha Playset.</p>' +
      '<p class="small">Último backup: <strong>' + (fmtDate(state.lastBackup) || 'nenhum') + '</strong></p>' +
      '<p class="small" id="bkStatus" role="status" aria-live="polite">' + (backupMsg ? '<strong>' + esc(backupMsg) + '</strong>' : '') + '</p>' +
      '<button class="btn primary full" data-act="backup">Enviar backup (WhatsApp, Telegram…)</button>' +
      '<button class="btn full" data-act="backupcopy">Copiar o backup como texto</button>' +
      '<h4 style="font-size:1rem;margin-top:12px">Voltar um backup</h4>' +
      '<p class="muted small">Se preferir colar: abra a mensagem do backup, copie o texto inteiro e cole aqui. Antes de importar, guardo uma cópia do que está no app agora.</p>' +
      '<label for="bkText" class="small">Cole aqui a mensagem do backup</label>' +
      '<textarea id="bkText" spellcheck="false" autocapitalize="off" style="min-height:96px"></textarea>' +
      '<button class="btn full" data-act="importtext">Importar do texto</button>' +
      '<label class="btn full" for="restore">Importar de um arquivo (backup antigo)</label>' +
      '<input type="file" id="restore" accept="*/*" class="visually-hidden">' +
      (function () {
        var sn = readSnap();
        if (!sn) return '';
        return '<h4 style="font-size:1rem;margin-top:12px">Cópia automática</h4>' +
          '<p class="muted small">' + esc(sn.reason) + ' · guardada em ' + esc(fmtDate(sn.at)) + '. Se alguma atualização bagunçar seus decks, volte para ela.</p>' +
          '<button class="btn full" data-act="snaprestore">Voltar os decks para essa cópia</button>';
      })() + '</section>');
    return '<header class="head"><h1>Mais</h1></header><div class="form">' + (nag ? gBackup + gPrices + gTools : gPrices + gTools + gBackup) +
      '<p class="xs muted">Dados, imagens e símbolos das cartas: Scryfall. Playset não é afiliado à Wizards of the Coast.</p></div>';
  }

  /* ---------- fontes e listas de referência ---------- */
  var CATALOG_KEY = 'fu.catalog.at';
  var catalogIdx = null;
  function knownIndex() {
    return FU.buildIndex(Object.keys(db.cards).map(function (k) { return db.cards[k]; }).filter(function (c) { return !c.notFound; }).map(function (c) { return c.name; }));
  }
  /* Lista oficial de nomes de cartas (Scryfall), para corrigir o que o print leu. */
  function loadCatalog() {
    if (catalogIdx) return Promise.resolve(catalogIdx);
    var url = SCRY + '/catalog/card-names';
    var fromCache = ('caches' in window) ? caches.open('fu-catalog').then(function (c) { return c.match(url); }).catch(function () { return null; }) : Promise.resolve(null);
    return fromCache.then(function (hit) {
      var fresh = false;
      try { fresh = Date.now() - Number(localStorage.getItem(CATALOG_KEY) || 0) < 7 * 864e5; } catch (e) {}
      if (hit && (fresh || !navigator.onLine)) return hit.json();
      return fetch(url, { headers: { 'Accept': 'application/json' } }).then(function (r) {
        if (!r.ok) throw new Error('catalog');
        if ('caches' in window) { var copy = r.clone(); caches.open('fu-catalog').then(function (c) { c.put(url, copy); try { localStorage.setItem(CATALOG_KEY, String(Date.now())); } catch (e) {} }).catch(function () {}); }
        return r.json();
      }).catch(function () { return hit ? hit.json() : null; });
    }).then(function (j) {
      catalogIdx = j && j.data ? FU.buildIndex(j.data) : null;
      return catalogIdx;
    });
  }

  var SITES = [
    [/moxfield\.com/i, 'Moxfield', 'No deck, toque em "Export" (Exportar) e depois em "Copy for MTGO". Volte aqui e cole.'],
    [/archidekt\.com/i, 'Archidekt', 'No deck, abra o menu "…", toque em "Export" e depois em "Copy". Volte aqui e cole.'],
    [/mtggoldfish\.com/i, 'MTG Goldfish', 'Na página do deck, toque em "Text" (ou "Download → Exact Card Versions") e copie a lista.'],
    [/ligamagic\.com\.br/i, 'Liga Magic', 'Na página do deck, use o botão de exportar/copiar a lista e cole aqui.'],
    [/edhrec\.com/i, 'EDHREC', 'Toque em "Export" ou "Copy decklist" e cole aqui.'],
    [/tappedout\.net/i, 'TappedOut', 'Use "Export → MTGO/Arena" e copie a lista.']
  ];
  function siteOf(url) {
    for (var i = 0; i < SITES.length; i++) if (SITES[i][0].test(url)) return SITES[i];
    return null;
  }
  var KIND = {
    text: { label: 'Texto', icon: svg('<path d="M4 6h16M4 12h16M4 18h10"/>') },
    image: { label: 'Print', icon: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="m21 17-5-5-8 8"/>') },
    link: { label: 'Link', icon: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>') }
  };

  /* Fontes do deck: moram dentro de "Em consideração". Uma linha por fonte; a não lida mostra o botão de colar a lista na própria linha. */
  function sourcesHtml(d) {
    var sources = d.sources || [], id = esc(d.id);
    var unread = sources.filter(function (x) { return !(x.cards && x.cards.length); });
    var read = sources.length - unread.length;
    var h = '<details class="srcbox"' + (unread.length || !sources.length ? ' open' : '') + '><summary style="min-height:44px;display:flex;align-items:center;cursor:pointer"><strong>Fontes (' + sources.length + (unread.length ? ' · ' + read + ' lidas' : '') + ')</strong></summary>';
    if (!sources.length) {
      return h + '<p class="small">Adicione listas de torneio, decks de outros jogadores, prints e links. Eu comparo as listas e as cartas que mais aparecem entram aqui embaixo.</p>' +
        '<a class="btn full" href="#/fonte/' + id + '">' + ICON.plus + 'Adicionar fonte</a></details>';
    }
    if (unread.length) h += '<p class="small err"><strong>' + unread.length + ' de ' + sources.length + (unread.length === 1 ? ' fontes não foi lida' : ' fontes não foram lidas') + '.</strong> O app não lê cartas por link (Moxfield, por exemplo). Fonte não lida não entra na comparação: abra a lista no site, copie o texto das cartas e cole.</p>';
    h += '<ul class="rows">' + sources.map(function (x) {
      var k = KIND[x.kind] || KIND.text, n = (x.cards || []).reduce(function (a, c) { return a + c.qty; }, 0);
      return '<li class="r src"><span class="q" aria-hidden="true">' + k.icon + '</span>' +
        '<span class="nm" style="cursor:default">' + esc(x.label || k.label) +
        '<span class="d">' + k.label + ' · ' + (n ? n + ' cartas lidas' : '<strong style="color:var(--miss)">NÃO LIDA</strong>') + ' · ' + esc(fmtDate(x.createdAt).split(' ')[0]) + '</span>' +
        (n ? '' : '<a class="btn primary" style="margin-top:6px" href="#/fonte/' + id + '?fill=' + esc(x.id) + '" aria-label="Colar a lista de ' + esc(x.label || 'link') + '">Colar a lista</a>') + '</span>' +
        (x.url ? '<a class="ib" href="' + esc(x.url) + '" target="_blank" rel="noopener" aria-label="Abrir ' + esc(x.label || 'link') + '">' + svg('<path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>') + '</a>' : '<span></span>') +
        '<button class="ib" data-delsrc="' + esc(x.id) + '" aria-label="Remover fonte ' + esc(x.label || k.label) + '">' + svg('<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>') + '</button></li>';
    }).join('') + '</ul><a class="btn full" href="#/fonte/' + id + '">' + ICON.plus + 'Adicionar fonte</a></details>';
    return h;
  }

  /* rascunho da fonte em edição (só em memória) */
  var draft = null;
  function newDraft(deckId) { return { deckId: deckId, kind: 'text', label: '', url: '', text: '', stage: 'input', rows: null, busy: '', err: '' }; }

  function viewFonte(deckId) {
    var d = deckById(deckId);
    barAction.innerHTML = ''; fab.innerHTML = '';
    if (!d) return '<div class="card empty"><p>Deck não encontrado.</p></div>';
    var fq = /(?:^|&)fill=([^&]+)/.exec(route().query || ''), fillId = fq ? decodeURIComponent(fq[1]) : '';
    var fillSrc = fillId ? (d.sources || []).filter(function (x) { return x.id === fillId; })[0] : null;
    if (!fillSrc) fillId = '';
    if (!draft || draft.deckId !== deckId || (draft.fillId || '') !== fillId) { draft = newDraft(deckId); draft.fillId = fillId; }
    var html = '<header class="head"><a href="#/deck/' + esc(d.id) + '" class="link" style="margin-left:-4px" data-dropdraft>' + ICON.back + esc(d.name) + '</a>' +
      '<h1>' + (fillSrc ? 'Colar a lista' : 'Adicionar fonte') + '</h1></header>';

    if (draft.stage === 'review') return html + reviewHtml();

    html += '<form id="srcForm" class="form" novalidate>' +
      '<div><label for="st">' + (fillSrc ? 'Cole as cartas de “' + esc(fillSrc.label || 'link') + '”' : 'Cole aqui') + '</label><p class="small muted" id="sth" style="margin:0 0 8px">' + (fillSrc ? 'Abra a lista no site, copie o texto das cartas (no Moxfield: Export, copiar como texto) e cole aqui, uma carta por linha, ex.: 4 Counterspell.' : 'Um link, uma lista (ex.: 4 Counterspell) ou os dois. Se escrever um texto junto, ele vira o nome da fonte.') + '</p>' +
      '<textarea id="st" aria-describedby="sth srcHint" spellcheck="false" autocapitalize="off" placeholder="https://moxfield.com/decks/…&#10;Campeão do torneio de outubro&#10;4 Counterspell">' + esc(draft.text) + '</textarea></div>' +
      '<div id="srcHint" class="small" aria-live="polite">' + srcHint(draft.text) + '</div>' +
      '<p id="srcErr" class="err" role="alert">' + esc(draft.err) + '</p>' +
      '<button class="btn primary full" type="submit">' + (fillSrc ? 'Ler e salvar a lista' : 'Salvar fonte') + '</button>' +
      '<section class="stack" aria-labelledby="fpH" style="margin-top:8px"><h2 id="fpH" class="small"><strong>Só tem um print da lista?</strong></h2>' +
      '<ol class="small" style="padding-left:20px;display:grid;gap:4px"><li>Toque em <strong>Copiar pedido</strong>.</li><li>Cole na sua IA e anexe o print.</li><li>Copie a resposta e cole no campo acima.</li></ol>' +
      '<button type="button" class="btn full" data-fcopy>' + ICON.copy + 'Copiar pedido</button></section></form>';
    return html;
  }
  function srcHint(text) {
    var s = FU.splitSource(text);
    var n = FU.parseList(s.list).cards.reduce(function (a, c) { return a + c.qty; }, 0);
    if (!s.url && !n && !s.label) return '';
    var site = s.url ? siteOf(s.url) : null;
    var bits = [];
    if (s.url) bits.push('link' + (site ? ' do ' + site[1] : ''));
    if (s.label) bits.push('nome “' + esc(s.label) + '”');
    if (n) bits.push(n + (n === 1 ? ' carta' : ' cartas'));
    var out = '<p><strong>Entendi:</strong> ' + bits.join(' · ') + '</p>';
    if (s.url && !n) out += '<p class="err" style="margin-top:4px"><strong>Atenção:</strong> o app não lê cartas por link. Se salvar só o link, esta fonte NÃO entra na comparação. Cole também a lista das cartas. ' + (site ? esc(site[1]) + ': ' + esc(site[2]) : 'Para as cartas entrarem na comparação, cole a lista também.') + '</p>';
    return out;
  }

  function reviewHtml() {
    var rows = draft.rows;
    var bad = rows.filter(function (r) { return r.status !== 'ok'; }).length;
    var html = '<div class="form" style="gap:8px">' +
      '<p class="small">' + (draft.kind === 'image' ? 'Li ' : 'Encontrei ') + '<strong>' + rows.length + ' cartas</strong>.' +
      (bad ? (bad === 1 ? ' Confira a carta marcada: corrigi o nome ou não reconheci.' : ' Confira as <strong>' + bad + '</strong> marcadas: corrigi o nome ou não reconheci.') : ' Todos os nomes batem com a lista oficial.') + '</p>' +
      (draft.catalogMissing ? '<p class="xs muted">Não consegui baixar a lista oficial de nomes agora, então só comparei com as cartas que o app já conhece.</p>' : '') + '</div>' +
      '<ul class="rows" id="revList">';
    rows.forEach(function (r, i) {
      var tag = r.status === 'fixed' ? '<span class="flag" style="border-color:var(--accent);color:var(--accent)">corrigido</span>' : (r.status === 'unknown' ? '<span class="flag">não reconheci</span>' : '');
      html += '<li class="r rev" style="grid-template-columns:64px minmax(0,1fr) auto">' +
        '<label class="visually-hidden" for="rq' + i + '">Quantidade</label><input id="rq' + i + '" data-rq="' + i + '" type="text" inputmode="numeric" value="' + r.qty + '" style="width:56px;text-align:center;padding:8px 4px">' +
        '<div style="min-width:0"><label class="visually-hidden" for="rn' + i + '">Nome da carta</label><input id="rn' + i + '" data-rn="' + i + '" type="text" autocomplete="off" spellcheck="false" value="' + esc(r.name) + '">' +
        (function () { var bits = []; if (r.status === 'fixed') bits.push(tag + ' lido: "' + esc(r.raw) + '"'); else if (tag) bits.push(tag); if (r.board === 'side') bits.push('sideboard'); return bits.length ? '<p class="xs muted" style="margin-top:4px">' + bits.join(' · ') + '</p>' : ''; })() + '</div>' +
        '<button class="ib" data-rdel="' + i + '" aria-label="Remover ' + esc(r.name) + '">' + svg('<path d="M6 6l12 12M18 6 6 18"/>') + '</button></li>';
    });
    return html + '</ul><div class="form"><button class="btn primary full" data-savereview>Salvar fonte (' + rows.reduce(function (a, r) { return a + (r.qty || 0); }, 0) + ' cartas)</button>' +
      '<button class="btn full" data-backinput>Voltar</button></div>';
  }

  function buildRows(text, idx) {
    var parsed = FU.parseList(text);
    var merged = {}, rows = [];
    parsed.cards.forEach(function (c) {
      var res = idx ? FU.resolveName(c.name, idx) : { name: c.name, status: 'ok' };
      var k = c.board + '|' + FU.key(res.name);
      if (merged[k]) { merged[k].qty += c.qty; return; }
      var row = { qty: c.qty, name: res.name, raw: c.name, status: res.status, board: c.board };
      merged[k] = row; rows.push(row);
    });
    return { rows: rows, skipped: parsed.skipped };
  }

  function saveDraftSource(cards) {
    var d = deckById(draft.deckId);
    d.sources = d.sources || [];
    var fillT = draft.fillId ? d.sources.filter(function (x) { return x.id === draft.fillId; })[0] : null;
    if (fillT) {
      fillT.cards = cards; fillT.readAt = Date.now();
      state.ui.view[d.id + ':tab'] = 'deck';
      persist(true);
      var nm0 = cards.map(function (c) { return c.name; }).filter(function (n) { var i = cardInfo(n); return !i || !i.typeLine; });
      draft = null; goReplace('#/deck/' + d.id);
      toast('Lista lida: ' + cards.reduce(function (a, c) { return a + c.qty; }, 0) + ' cartas entraram na comparação.');
      if (nm0.length) refreshPrices({ only: nm0, silent: true });
      return;
    }
    d.sources.push({
      id: newId(), kind: draft.kind, label: draft.label.trim() || (draft.url ? (siteOf(draft.url) || [0, 'Link'])[1] : KIND[draft.kind].label + ' ' + (d.sources.length + 1)),
      url: (draft.url || '').trim(), cards: cards, createdAt: Date.now()
    });
    state.ui.view[d.id + ':tab'] = 'deck';
    persist(true);
    var names = cards.map(function (c) { return c.name; }).filter(function (n) { var i = cardInfo(n); return !i || !i.typeLine; });
    draft = null;
    goReplace('#/deck/' + d.id);
    toast(cards.length ? 'Fonte adicionada.' : 'Link salvo, mas as cartas NÃO foram lidas. Ela não entra na comparação até você colar a lista.');
    if (names.length) refreshPrices({ only: names, silent: true });
  }

  function readDraftInputs() {
    var l = document.getElementById('sl'); if (l) draft.label = l.value;
    var t = document.getElementById('st'); if (t) draft.text = t.value;
    var u = document.getElementById('su'); if (u) draft.url = u.value.trim();
  }
  function readReviewInputs() {
    if (!draft || !draft.rows) return;
    draft.rows.forEach(function (r, i) {
      var q = document.getElementById('rq' + i), n = document.getElementById('rn' + i);
      if (q) r.qty = Math.max(0, Math.min(99, parseInt(q.value, 10) || 0));
      if (n && n.value.trim() !== r.name) { r.name = n.value.trim(); r.status = 'ok'; }
    });
  }

  function submitText() {
    readDraftInputs();
    var s = FU.splitSource(draft.text);
    var fillS = draft.fillId ? (deckById(draft.deckId).sources || []).filter(function (x) { return x.id === draft.fillId; })[0] : null;
    if (fillS) {
      draft.url = fillS.url || ''; draft.label = fillS.label || ''; draft.kind = fillS.kind || 'link';
      if (!s.list.trim()) { draft.err = 'Não encontrei cartas. Cole o texto das cartas, uma por linha, ex.: 4 Counterspell.'; render(); keepFocus('#st'); return; }
    } else { draft.url = s.url; draft.label = s.label; draft.kind = s.url ? 'link' : 'text'; }
    if (!fillS && !s.url && !s.list.trim()) {
      draft.err = draft.text.trim() ? 'Não encontrei link nem cartas. Use uma carta por linha, ex.: 4 Counterspell.' : 'Cole um link ou uma lista primeiro.';
      render(); keepFocus('#st'); return;
    }
    if (!s.list.trim()) { saveDraftSource([]); return; }
    draft.err = '';
    var idx0 = catalogIdx || knownIndex();
    var pre = buildRows(s.list, idx0);
    if (!pre.rows.length) { draft.err = 'Não encontrei cartas. Use uma carta por linha, ex.: 4 Counterspell.'; render(); keepFocus('#st'); return; }
    loadCatalog().then(function (idx) {
      var res = buildRows(s.list, idx || idx0);
      draft.catalogMissing = !idx;
      if (res.rows.every(function (r) { return r.status === 'ok'; })) {
        saveDraftSource(res.rows.map(function (r) { return { name: r.name, qty: r.qty, board: r.board, owned: 0 }; }));
      } else { draft.rows = res.rows; draft.stage = 'review'; render(); window.scrollTo(0, 0); }
    });
  }

  function addToDeck(d, name, qty, board) {
    var nm = canonical(name);
    var ex = d.cards.filter(function (c) { return c.board === board && FU.key(canonical(c.name)) === FU.key(nm); })[0];
    if (ex) ex.qty = Math.max(ex.qty, qty);
    else { var tk = takeSpareEds(nm, qty); d.cards.push({ name: nm, qty: qty, board: board === 'commander' ? 'commander' : (board === 'side' ? 'side' : 'main'), owned: tk.n, eds: tk.eds }); }
  }

  /* ---------- Coleção: tudo que a pessoa tem, com o que está fora dos decks em primeiro lugar ---------- */
  function collectionData() {
    var map = {};
    function row(nm) { var k = FU.key(nm); return map[k] || (map[k] = { name: nm, decks: [], spare: 0, total: 0, eds: [] }); }
    state.decks.forEach(function (d) {
      d.cards.forEach(function (c) {
        if (!(c.owned > 0)) return;
        var nm = canonical(c.name);
        if (FU.isBasic(nm)) return;
        var r = row(nm), ex = r.decks.filter(function (x) { return x.id === d.id; })[0];
        if (ex) ex.n += c.owned; else r.decks.push({ id: d.id, name: d.name, n: c.owned });
        r.total += c.owned;
        r.eds = FU.edsMerge(r.eds, FU.edsTake(c.eds, c.owned).taken);
      });
    });
    var s = spareMap();
    Object.keys(s).forEach(function (k) {
      var r = row(s[k].name);
      r.spare += s[k].qty; r.total += s[k].qty;
      r.eds = FU.edsMerge(r.eds, FU.edsTake(s[k].eds, s[k].qty).taken);
    });
    return Object.keys(map).map(function (k) { return map[k]; });
  }
  function viewColecao() {
    fab.innerHTML = ''; barAction.innerHTML = '';
    var ui = state.ui, tab = ui.colTab === 'all' ? 'all' : 'out';
    var all = collectionData(), outN = 0, allN = 0;
    all.forEach(function (r) { outN += r.spare; allN += r.total; });
    var cnt = function (r) { return tab === 'all' ? r.total : r.spare; };
    var items = all.filter(function (r) { return cnt(r) > 0; });
    var html = '<header class="head"><h1>Coleção</h1><p class="metaline">' + allN + (allN === 1 ? ' carta' : ' cartas') + ' que você tem · ' + outN + ' fora dos decks</p></header>' +
      '<div style="padding:0 16px 12px"><a class="btn primary full" href="#/troca">' + ICO.swap + 'Modo troca: ver preço na Liga</a></div>' +
      '<div class="tabsbar" role="tablist" aria-label="Coleção">' +
      '<button role="tab" data-ctab="out" aria-selected="' + (tab === 'out') + '">Fora dos decks (' + outN + ')</button>' +
      '<button role="tab" data-ctab="all" aria-selected="' + (tab === 'all') + '">Tudo que tenho (' + allN + ')</button></div>' +
      toolsBar([toolBtn('data-photo="colecao"', ICO.cam, 'Importar por foto')], 'colecao');
    if (!items.length) {
      html += '<div class="card pad stack" style="margin:16px"><p><strong>' + (tab === 'out' ? 'Nada guardado fora dos decks.' : 'Você ainda não marcou nenhuma carta.') + '</strong></p>' +
        '<p class="muted small">As cartas que você tem e não estão em nenhum deck ficam aqui. Adicione uma por vez abaixo ou importe uma foto.</p>' +
        '<button class="btn primary full" data-photo="colecao">' + ICO.cam + 'Importar por foto</button></div>';
    } else {
      var grid = ui.view.colecao !== 'list';
      groupByType(items, function (r) { return r.name; }).forEach(function (g) {
        sortItems(g.items, function (r) { return r.name; }, cnt);
        var n = g.items.reduce(function (a, r) { return a + cnt(r); }, 0), key = 'c:' + g.title;
        html += '<section class="sec">' + secHead(key, g.title, n);
        if (!isClosed(key)) {
          html += grid ? '<ul class="grid">' + g.items.map(function (r) {
            var info = cardInfo(r.name), pr = moneyShort(info, cnt(r));
            return '<li><button class="gc" data-card="' + esc(r.name) + '" aria-label="Você tem ' + cnt(r) + ' ' + esc(r.name) + (r.eds.length ? ', edições ' + esc(edsShort(r.eds)) : '') + '">' +
              (imgOf(info) ? '<img src="' + esc(imgOf(info)) + '" alt="" loading="lazy" decoding="async" width="488" height="680">' : '<span class="ph" style="' + phStyle(info) + '">' + esc(r.name) + '</span>') +
              '<span class="cap" aria-hidden="true"><span>×' + cnt(r) + '</span><span>' + (r.eds.length ? esc(edsShort(r.eds)) : (pr || '')) + '</span></span></button></li>';
          }).join('') + '</ul>' : '<ul class="rows">' + g.items.map(function (r) {
            var info = cardInfo(r.name), parts = [];
            if (tab === 'all') { r.decks.forEach(function (d) { parts.push(d.name + ' ' + d.n); }); if (r.spare) parts.push('fora dos decks ' + r.spare); }
            if (r.eds.length) parts.push(edsShort(r.eds));
            return '<li class="r"><span class="q" aria-label="você tem ' + cnt(r) + '">' + cnt(r) + '</span>' +
              '<button class="nm" data-card="' + esc(r.name) + '">' + esc(r.name) + (parts.length ? '<span class="d">' + esc(parts.join(' · ')) + '</span>' : '') + '</button>' +
              rowTools(info, r.name) + priceCell(info, cnt(r)) + '</li>';
          }).join('') + '</ul>';
        }
        html += '</section>';
      });
    }
    return html + addCardHtml({ id: 'colecao' }, 'colecao') + '<p class="foot">Terrenos básicos não entram. Marque “tenho” nos decks ou importe uma foto e as cartas aparecem aqui.</p>';
  }

  /* ---------- importar por foto: a IA da pessoa lê a foto, o app lê a resposta ---------- */
  ICO.pin = svg('<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 14v7"/>');
  ICO.check = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 2.8);
  ICO.cam = svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>');
  var photo = null;
  var AIS = [['claude', 'Claude', 'https://claude.ai/new?q='], ['chatgpt', 'ChatGPT', 'https://chatgpt.com/?q='], ['gemini', 'Gemini', 'https://gemini.google.com/app']];
  function listPrintPrompt() {
    return ['Leia o print anexo. Ele mostra a lista de cartas de um deck de Magic: The Gathering.',
      'Responda SOMENTE com a lista, uma carta por linha, neste formato: 4 Counterspell. Use o nome da carta em inglês. Se houver sideboard, escreva uma linha só com a palavra Sideboard antes das cartas do sideboard. Se não conseguir ler uma carta, escreva o que conseguir e coloque ? no fim da linha. Sem títulos, explicações nem comentários.',
      'Coloque a lista inteira dentro de um único bloco de código (três crases), para eu copiar com um toque.'].join('\n\n');
  }
  function photoPrompt() {
    return [
      'Vou te enviar foto(s) de cartas de Magic: The Gathering.',
      'Para cada carta, leia: o nome em inglês, o código da edição (3 a 5 letras, no rodapé da carta, ex.: TMP, 2XM, MH3) e o número de colecionador (ao lado do código, ex.: 123).',
      'Responda SOMENTE com a lista, uma carta por linha, neste formato exato:',
      '1 Nome da Carta (EDIT) 123',
      'Regras: se a mesma carta aparecer em edições diferentes, use uma linha para cada edição. Se a foto mostrar um deck com sideboard, escreva uma linha só com a palavra Sideboard antes das cartas do sideboard. Se não tiver certeza do nome, da edição ou do número, escreva o que conseguir e coloque ? no fim da linha. Se a carta for foil, acrescente *F* no fim da linha. Não escreva títulos, explicações nem comentários.',
      'Coloque a lista inteira dentro de um único bloco de código, para eu copiar com um toque.',
      'Agora vou enviar as fotos.'
    ].join('\n\n');
  }


  /* ---------- modo troca: preço salvo + atalho para a Liga, rápido na mesa ---------- */
  ICO.swap = svg('<path d="M7 7h12M16 3l4 4-4 4M17 17H5M8 13l-4 4 4 4"/>');
  var trQuery = '';
  function trocaMatches(q) {
    var words = FU.norm(q).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    var set = {};
    ligaNames().forEach(function (n) { set[FU.key(canonical(n))] = canonical(n); });
    Object.keys(db.cards).forEach(function (k) { var c = db.cards[k]; if (c && !c.notFound && c.name && !FU.isBasic(c.name)) set[FU.key(c.name)] = c.name; });
    var out = Object.keys(set).map(function (k) { return set[k]; }).filter(function (n) {
      var nn = FU.norm(n);
      return words.every(function (w) { return nn.indexOf(w) !== -1; });
    });
    var first = FU.norm(q);
    out.sort(function (a, b) {
      var A = FU.norm(a).indexOf(first) === 0 ? 0 : 1, B = FU.norm(b).indexOf(first) === 0 ? 0 : 1;
      return A - B || a.localeCompare(b);
    });
    return out.slice(0, 8);
  }
  function trocaRow(name) {
    var info = cardInfo(name), n = ligaNote(info);
    var price;
    if (n) {
      var stale = ligaDays(n) > LIGA_STALE;
      price = '<span class="v">' + brl.format(n.brl) + '</span>' +
        (n.src === 'print' && (n.min != null || n.max != null) ? '<span class="small muted">menor ' + (n.min != null ? brl.format(n.min) : '-') + ' · maior ' + (n.max != null ? brl.format(n.max) : '-') + '</span>' : '') +
        '<span class="small ' + (stale ? 'old' : 'muted') + '">Liga, ' + ligaAgeText(n) + (stale ? ' · confira' : '') + '</span>';
    } else {
      var est = moneyShort(info, 1);
      price = est ? '<span class="v">' + est + '</span><span class="small muted">estimativa do Scryfall, sem preço da Liga salvo</span>' : '<span class="small muted">Sem preço salvo</span>';
    }
    return '<li class="tr"><button class="nm" data-card="' + esc(name) + '">' + esc(name) + '</button>' +
      '<a class="btn primary go" href="' + esc(ligaUrl(name)) + '" target="_blank" rel="noopener">Abrir na Liga' + ICO_EXT + '</a>' +
      '<div class="tp">' + price + '</div></li>';
  }
  function trocaOut() {
    var q = trQuery.trim();
    if (!q) return '<p class="muted small" style="padding:12px 16px">Digite o nome da carta. Mostro o preço salvo e abro a Liga com um toque.</p>';
    var m = trocaMatches(q);
    return (m.length ? '<ul class="trlist">' + m.map(trocaRow).join('') + '</ul>' : '<p class="muted small" style="padding:12px 16px">Nenhuma carta sua com esse nome.</p>') +
      '<a class="btn full trfree go" href="' + esc(ligaSearchUrl(q)) + '" target="_blank" rel="noopener">Buscar “' + esc(q) + '” na Liga Magic' + ICO_EXT + '</a>';
  }
  function viewTroca() {
    barAction.innerHTML = ''; fab.innerHTML = '';
    var cv = ligaCoverage();
    return '<header class="head"><a href="#/colecao" class="link" style="margin-left:-4px" data-goback>' + ICON.back + 'Voltar</a><h1>Modo troca</h1>' +
      '<p class="metaline">' + cv.have + ' de ' + cv.total + ' cartas suas com preço da Liga salvo</p></header>' +
      '<div class="form"><label for="trIn" class="visually-hidden">Nome da carta</label>' +
      '<input type="search" id="trIn" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Nome da carta, em português ou inglês" value="' + esc(trQuery) + '"></div>' +
      (navigator.onLine ? '' : '<p class="small" role="status" style="padding:0 16px;color:var(--miss);font-weight:700">Sem internet agora. Valem os preços salvos.</p>') +
      '<div id="trOut" aria-live="polite">' + trocaOut() + '</div>';
  }

  /* ---------- preços da Liga Magic por print ---------- */
  var lp = null;
  function ligaNames() {
    var set = {};
    state.decks.forEach(function (d) { d.cards.forEach(function (c) { if (!FU.isBasic(c.name)) set[FU.key(c.name)] = c.name; }); });
    var sp = state.spare || {};
    Object.keys(sp).forEach(function (k) { if (sp[k] && sp[k].qty > 0 && !FU.isBasic(sp[k].name)) set[k] = sp[k].name; });
    return Object.keys(set).map(function (k) { return set[k]; });
  }
  function ligaCoverage() {
    var names = ligaNames(), have = 0, last = 0, miss = [];
    names.forEach(function (n) {
      var v = state.liga && state.liga[FU.key(canonical(n))];
      if (v) { have++; if (v.at > last) last = v.at; } else miss.push(canonical(n));
    });
    return { total: names.length, have: have, last: last, miss: miss };
  }
  function precosPrompt() {
    return [
      'Vou te enviar prints de páginas de cartas do site Liga Magic (ligamagic.com.br).',
      'Em cada print, leia: (1) o nome da carta em inglês, que aparece em itálico logo abaixo do nome em português; (2) no bloco "Preço Médio de Venda no Marketplace", na linha "Normal", os três valores em R$, da esquerda para a direita: menor, médio e maior.',
      'Responda SOMENTE com uma linha por carta, neste formato exato:',
      'Nome em inglês | menor | médio | maior',
      'Exemplo: Eternal Dragon | 3,00 | 7,72 | 100,00',
      'Regras: use só números, com vírgula nos centavos e sem R$. Se não conseguir ler um valor, escreva - no lugar. Se a mesma carta aparecer em mais de um print, escreva uma linha só. Não escreva títulos, explicações nem comentários.',
      'Coloque tudo dentro de um único bloco de código, para eu copiar com um toque.',
      'Agora vou enviar os prints.'
    ].join('\n\n');
  }
  function readLpInputs() { var x = document.getElementById('ltext'); if (x && lp) lp.text = x.value; }
  function readLpReview() {
    if (!lp || !lp.rows) return;
    lp.rows.forEach(function (r, i) {
      var n = document.getElementById('ln' + i);
      if (n && n.value.trim() !== r.name) { r.name = n.value.trim(); r.status = 'ok'; r.edited = true; }
    });
  }
  function viewPrecos() {
    barAction.innerHTML = ''; fab.innerHTML = '';
    if (!lp) lp = { step: 'input', text: '', rows: null, busy: '', err: '', skipped: 0 };
    var html = '<header class="head"><a href="#/mais" class="link" style="margin-left:-4px" data-droplp data-goback>' + ICON.back + 'Voltar</a><h1>Preços da Liga Magic</h1></header>';
    if (lp.step === 'review') return html + precosReviewHtml();
    var cv = ligaCoverage();
    html += '<div class="form pphoto">' +
      '<p class="small"><strong>' + cv.have + ' de ' + cv.total + '</strong> cartas suas têm preço da Liga' + (cv.last ? ' · último em ' + esc(fmtDate(cv.last)) : '') + '. Os preços ficam salvos no aparelho e aparecem sem internet.</p>' +
      '<section aria-labelledby="l1"><h2 id="l1" class="ph-h"><span aria-hidden="true">1</span>Tire os prints na Liga</h2>' +
      '<p class="small muted">Abra a carta na Liga (botão “Ver preço na Liga Magic” no pop-up da carta) e tire um print que mostre o nome e o bloco “Preço Médio de Venda no Marketplace”. Dá para mandar vários prints de uma vez.</p>' +
      '<button type="button" class="btn full" data-lnames style="margin-top:8px"' + (cv.miss.length ? '' : ' disabled') + '>' + ICON.copy + 'Copiar nomes das ' + cv.miss.length + ' sem preço</button></section>' +
      '<section aria-labelledby="l2"><h2 id="l2" class="ph-h"><span aria-hidden="true">2</span>Peça os preços para a sua IA</h2>' +
      '<p class="small muted">Eu copio um pedido pronto. Abra a IA que você usa, cole o pedido e mande os prints na mesma conversa.</p>' +
      '<button type="button" class="btn primary full" data-lcopy style="margin-top:8px">' + ICON.copy + 'Copiar pedido</button>' +
      '<div class="aibtns">' + AIS.map(function (a) { return '<button type="button" class="btn" data-lai="' + a[0] + '">Copiar e abrir ' + a[1] + '</button>'; }).join('') + '</div></section>' +
      '<section aria-labelledby="l3"><h2 id="l3" class="ph-h"><span aria-hidden="true">3</span>Cole a resposta aqui</h2>' +
      '<label for="ltext" class="visually-hidden">Resposta da IA</label><textarea id="ltext" spellcheck="false" autocapitalize="off" placeholder="Eternal Dragon | 3,00 | 7,72 | 100,00&#10;Sol Ring | 1,50 | 2,80 | 9,00" style="margin-top:8px">' + esc(lp.text) + '</textarea>' +
      '<p id="lErr" class="err" role="alert" style="margin-top:8px">' + esc(lp.err) + '</p>' +
      (lp.busy ? '<p class="small" role="status" aria-live="polite"><strong>' + esc(lp.busy) + '</strong></p>' : '') +
      '<button type="button" class="btn primary full" data-lread style="margin-top:8px">Ler preços</button></section></div>';
    return html;
  }
  function precosReviewHtml() {
    var rows = lp.rows, ok = rows.filter(function (r) { return r.status !== 'unknown'; }).length;
    var check = rows.length - rows.filter(function (r) { return r.status === 'ok' && !r.odd; }).length;
    var html = '<div class="form" style="gap:8px"><p class="small">Li <strong>' + rows.length + (rows.length === 1 ? ' preço' : ' preços') + '</strong>. ' +
      (check ? 'Confira os <strong>' + check + '</strong> marcados.' : 'Nomes e valores conferem.') + ' O valor em destaque é o <strong>médio</strong>.' +
      (lp.skipped ? ' Ignorei ' + lp.skipped + (lp.skipped === 1 ? ' linha' : ' linhas') + ' que não entendi.' : '') + '</p>' +
      (lp.catalogMissing ? '<p class="xs muted">Sem a lista oficial de nomes agora: só comparei com as cartas que o app já conhece.</p>' : '') + '</div><ul class="rows" id="revList">';
    var mine = {}; ligaNames().forEach(function (n) { mine[FU.key(canonical(n))] = 1; });
    rows.forEach(function (r, i) {
      var flags = [];
      if (r.status === 'fixed') flags.push('nome corrigido (li “' + esc(r.raw) + '”)');
      else if (r.status === 'unknown') flags.push('não reconheci o nome, não será salvo');
      if (r.odd) flags.push('menor, médio e maior fora de ordem');
      if (r.status !== 'unknown' && !mine[FU.key(canonical(r.name))]) flags.push('não está nos seus decks nem na coleção');
      var f = function (v) { return v == null ? '-' : brl.format(v); };
      html += '<li class="r rev" style="grid-template-columns:minmax(0,1fr) auto"><div style="min-width:0">' +
        '<label class="visually-hidden" for="ln' + i + '">Nome da carta</label><input id="ln' + i + '" type="text" autocomplete="off" spellcheck="false" value="' + esc(r.name) + '">' +
        (flags.length ? '<p class="xs" style="margin-top:4px;color:var(--miss);font-weight:700">' + flags.join(' · ') + '</p>' : '') +
        '<p class="small" style="margin-top:4px"><strong>' + f(r.avg) + '</strong> médio · <span class="muted">menor ' + f(r.min) + ' · maior ' + f(r.max) + '</span></p></div>' +
        '<button class="ib" data-ldel="' + i + '" aria-label="Remover ' + esc(r.name) + '">' + svg('<path d="M6 6l12 12M18 6 6 18"/>') + '</button></li>';
    });
    return html + '</ul><div class="form"><button class="btn primary full" data-lsave' + (ok ? '' : ' disabled') + '>Salvar ' + ok + (ok === 1 ? ' preço' : ' preços') + '</button><button class="btn full" data-lback>Voltar</button></div>';
  }
  function precosRead() {
    readLpInputs();
    if (!lp.text.trim()) { lp.err = 'Cole aqui a resposta da IA.'; render(); keepFocus('#ltext'); return; }
    var parsed = FU.parseLigaPrices(lp.text);
    if (!parsed.rows.length) { lp.err = 'Não achei preços nessa resposta. Peça à IA para responder só com linhas no formato: Nome | menor | médio | maior.'; render(); keepFocus('#ltext'); return; }
    lp.err = ''; lp.busy = 'Conferindo os nomes…'; render();
    loadCatalog().then(function (idx) {
      lp.catalogMissing = !idx;
      var use = idx || knownIndex();
      lp.rows = parsed.rows.map(function (r) {
        var res = FU.resolveName(r.name, use);
        r.name = res.name; r.status = res.status; return r;
      });
      lp.skipped = parsed.skipped.length;
      lp.busy = ''; lp.step = 'review'; render(); window.scrollTo(0, 0);
    }).catch(function () { lp.busy = ''; lp.err = 'Não consegui conferir agora. Tente de novo.'; render(); });
  }
  function precosSave() {
    readLpReview();
    var n = 0, now = Date.now();
    state.liga = state.liga || {};
    lp.rows.forEach(function (r) {
      if (r.status === 'unknown' || !(r.avg > 0)) return;
      state.liga[FU.key(canonical(r.name))] = { brl: r.avg, avg: r.avg, min: r.min, max: r.max, at: now, src: 'print' };
      n++;
    });
    persist(true);
    lp = null;
    toast(n + (n === 1 ? ' preço da Liga salvo.' : ' preços da Liga salvos.'));
    goReplace('#/mais');
    render();
  }

  function newPhoto(id) {
    return { id: id, step: 'input', target: id === 'colecao' ? 'colecao' : (id && id !== 'novo' && deckById(id) ? id : 'novo'), name: '', format: 'Premodern', text: '', rows: null, busy: '', err: '' };
  }
  function readPhotoInputs() {
    if (!photo) return;
    var t = document.getElementById('ptarget'); if (t) photo.target = t.value;
    var n = document.getElementById('pname'); if (n) photo.name = n.value;
    var f = document.getElementById('pfmt'); if (f) photo.format = f.value;
    var x = document.getElementById('ptext'); if (x) photo.text = x.value;
  }
  function readPhotoReview() {
    if (!photo || !photo.rows) return;
    photo.rows.forEach(function (r, i) {
      var q = document.getElementById('pq' + i), n = document.getElementById('pn' + i);
      if (q) r.qty = Math.max(0, Math.min(99, parseInt(q.value, 10) || 0));
      if (n && n.value.trim() !== r.name) { r.name = n.value.trim(); r.status = 'ok'; }
    });
  }
  function viewFoto(id) {
    barAction.innerHTML = ''; fab.innerHTML = '';
    if (!photo || photo.id !== id) photo = newPhoto(id);
    var back = id === 'colecao' ? '#/colecao' : (id && id !== 'novo' && deckById(id) ? '#/deck/' + esc(id) : '#/decks');
    var html = '<header class="head"><a href="' + back + '" class="link" style="margin-left:-4px" data-dropphoto data-goback>' + ICON.back + 'Voltar</a><h1>Importar por foto</h1></header>';
    if (photo.step === 'review') return html + photoReviewHtml();
    var fmts = ['Premodern', 'Commander', 'Pauper', 'Legacy', 'Modern', 'Outro'];
    var opts = '<option value="novo"' + (photo.target === 'novo' ? ' selected' : '') + '>Novo deck</option>' +
      state.decks.map(function (d) { return '<option value="' + esc(d.id) + '"' + (photo.target === d.id ? ' selected' : '') + '>' + esc(d.name) + (d.format === 'Lista' ? ' (lista)' : '') + '</option>'; }).join('') +
      '<option value="colecao"' + (photo.target === 'colecao' ? ' selected' : '') + '>Só na coleção (sem deck)</option>';
    html += '<div class="form pphoto">' +
      '<section aria-labelledby="p1"><h2 id="p1" class="ph-h"><span aria-hidden="true">1</span>Para onde vai?</h2>' +
      '<label for="ptarget" class="visually-hidden">Destino</label><select id="ptarget" class="field">' + opts + '</select>' +
      (photo.target === 'novo' ? '<div style="display:grid;gap:8px;margin-top:8px"><label for="pname" class="visually-hidden">Nome do deck</label><input type="text" id="pname" autocomplete="off" placeholder="Nome do deck, ex.: UW Control" value="' + esc(photo.name) + '">' +
        '<label for="pfmt" class="visually-hidden">Formato</label><select id="pfmt" class="field">' + fmts.map(function (f) { return '<option' + (photo.format === f ? ' selected' : '') + '>' + f + '</option>'; }).join('') + '</select></div>' : '') +
      '<p class="small" style="margin-top:8px"><strong>Dica para a foto sair boa:</strong> abra as cartas em leque (sem empilhar) e fotografe 8 a 10 por vez, com luz boa e sem reflexo.</p>' +
      '<p class="xs muted" style="margin-top:8px">As cartas entram marcadas como “tenho”. ' + (photo.target === 'colecao' ? 'Ficam na Coleção, fora de qualquer deck.' : 'Se a foto tiver mais cópias do que o deck pede, as que sobram vão para a Coleção.') + '</p></section>' +
      '<section aria-labelledby="p2"><h2 id="p2" class="ph-h"><span aria-hidden="true">2</span>Peça a lista para a sua IA</h2>' +
      '<p class="small muted">Eu copio um pedido pronto. Abra a IA que você usa, cole o pedido e mande a foto do deck ou das cartas na mesma conversa.</p>' +
      '<button type="button" class="btn primary full" data-pcopy style="margin-top:8px">' + ICON.copy + 'Copiar pedido</button>' +
      '<div class="aibtns">' + AIS.map(function (a) { return '<button type="button" class="btn" data-pai="' + a[0] + '">Copiar e abrir ' + a[1] + '</button>'; }).join('') + '</div>' +
      '<p class="xs muted" style="margin-top:8px">Funciona com qualquer IA que aceite foto. Se a IA abrir sem o pedido preenchido, é só colar.</p></section>' +
      '<section aria-labelledby="p3"><h2 id="p3" class="ph-h"><span aria-hidden="true">3</span>Cole a resposta aqui</h2>' +
      '<p class="small muted">Na IA, toque em copiar na lista que ela devolveu e volte aqui.</p>' +
      '<label for="ptext" class="visually-hidden">Resposta da IA</label><textarea id="ptext" spellcheck="false" autocapitalize="off" placeholder="1 Swords to Plowshares (TMP) 123&#10;2 Counterspell (7ED) 67" style="margin-top:8px">' + esc(photo.text) + '</textarea>' +
      '<p id="pErr" class="err" role="alert" style="margin-top:8px">' + esc(photo.err) + '</p>' +
      (photo.busy ? '<p class="small" role="status" aria-live="polite"><strong>' + esc(photo.busy) + '</strong></p>' : '') +
      '<button type="button" class="btn primary full" data-pread style="margin-top:8px">Ler lista</button></section></div>';
    return html;
  }
  function photoReviewHtml() {
    var rows = photo.rows;
    var sum = rows.reduce(function (a, r) { return a + (r.qty || 0); }, 0);
    var check = rows.filter(function (r) { return r.status !== 'ok' || r.unsure || r.edStatus === 'bad' || r.edStatus === 'fixed'; }).length;
    var dk = photo.target === 'novo' ? null : deckById(photo.target);
    var to = photo.target === 'novo' ? 'o novo deck “' + esc(photo.name.trim()) + '”' : (photo.target === 'colecao' ? 'a coleção' : esc(dk ? dk.name : 'o deck'));
    var html = '<div class="form" style="gap:8px"><p class="small">Li <strong>' + sum + (sum === 1 ? ' carta' : ' cartas') + '</strong> para ' + to + '. Todas entram como “tenho”.' +
      (check ? ' Confira as <strong>' + check + '</strong> marcadas.' : ' Nomes e edições conferem.') + '</p>' +
      (photo.catalogMissing ? '<p class="xs muted">Não consegui baixar a lista oficial de nomes agora, então só comparei com as cartas que o app já conhece.</p>' : '') + '</div><ul class="rows" id="revList">';
    rows.forEach(function (r, i) {
      var flags = [];
      if (r.status === 'fixed') flags.push('nome corrigido (li “' + esc(r.raw) + '”)'); else if (r.status === 'unknown') flags.push('não reconheci o nome');
      if (r.unsure) flags.push('a IA não teve certeza');
      var ed, p = r.info;
      if (r.edStatus === 'none') ed = '<span class="xs muted">Sem edição informada</span>';
      else if (r.edStatus === 'bad') ed = '<span class="xs" style="color:var(--miss)">Edição ' + esc(String(r.set).toUpperCase()) + (r.num ? ' #' + esc(r.num) : '') + ' não confere com esta carta. Entra sem edição.</span>';
      else ed = (p && p.sm ? '<img src="' + esc(p.sm) + '" alt="" width="56" height="78" loading="lazy">' : '') + '<span class="xs">' + esc(p && p.setName ? p.setName : String(r.set).toUpperCase()) + (r.num ? ' · #' + esc(r.num) : '') + (p && p.year ? ' · ' + esc(p.year) : '') +
        (r.foil ? ' · foil' : '') + (r.edStatus === 'fixed' ? ' · número corrigido' : '') + (r.edStatus === 'offline' ? ' · sem internet, não conferi' : '') + '</span>';
      html += '<li class="r rev" style="grid-template-columns:64px minmax(0,1fr) auto">' +
        '<label class="visually-hidden" for="pq' + i + '">Quantidade</label><input id="pq' + i + '" type="text" inputmode="numeric" value="' + r.qty + '" style="width:56px;text-align:center;padding:8px 4px">' +
        '<div style="min-width:0"><label class="visually-hidden" for="pn' + i + '">Nome da carta</label><input id="pn' + i + '" type="text" autocomplete="off" spellcheck="false" value="' + esc(r.name) + '">' +
        (flags.length ? '<p class="xs" style="margin-top:4px;color:var(--miss);font-weight:700">' + flags.join(' · ') + '</p>' : '') +
        (r.board === 'side' ? '<p class="xs muted" style="margin-top:2px">sideboard</p>' : '') + '<div class="edline">' + ed + '</div></div>' +
        '<button class="ib" data-pdel="' + i + '" aria-label="Remover ' + esc(r.name) + '">' + svg('<path d="M6 6l12 12M18 6 6 18"/>') + '</button></li>';
    });
    return html + '</ul><div class="form"><button class="btn primary full" data-psave>Salvar (' + sum + (sum === 1 ? ' carta)' : ' cartas)') + '</button><button class="btn full" data-pback>Voltar</button></div>';
  }
  function buildPhotoRows(cards, idx) {
    var rows = [];
    cards.forEach(function (c) {
      var res = FU.resolveName(c.name, idx);
      (c.lines || [{ n: c.qty }]).forEach(function (l) {
        rows.push({ qty: l.n, name: res.name, raw: c.name, status: res.status, board: c.board, set: l.set || '', num: l.num || '', foil: !!l.foil, unsure: !!l.unsure, edStatus: l.set ? 'pending' : 'none', info: null });
      });
    });
    return rows;
  }
  function postCollection(idents) {
    var chunks = [], out = [], failed = false, p = Promise.resolve();
    for (var i = 0; i < idents.length; i += 75) chunks.push(idents.slice(i, i + 75));
    chunks.forEach(function (ch, idx) {
      p = p.then(function () { return idx ? sleep(120) : null; }).then(function () {
        return fetch(SCRY + '/cards/collection', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ identifiers: ch }) })
          .then(function (r) { if (!r.ok) throw new Error('scry'); return r.json(); })
          .then(function (j) { out = out.concat(j.data || []); })
          .catch(function () { failed = true; });
      });
    });
    return p.then(function () { return { cards: out, failed: failed }; });
  }
  function printInfo(c) {
    var iu = c.image_uris || (c.card_faces && c.card_faces[0] && c.card_faces[0].image_uris) || {};
    return { set: c.set, num: c.collector_number, setName: c.set_name, year: (c.released_at || '').slice(0, 4), sm: iu.small || null, img: iu.normal || null };
  }
  function sameFront(a, b) { return FU.norm(String(a).split(' // ')[0]) === FU.norm(String(b).split(' // ')[0]); }
  /* Confere cada edição no Scryfall (set + número). Se o número não bate com a carta, tenta achar a edição pelo nome. */
  function verifyPrints(rows) {
    var withSet = rows.filter(function (r) { return r.set; });
    if (!withSet.length) return Promise.resolve();
    var offline = function () { withSet.forEach(function (r) { r.edStatus = 'offline'; }); };
    if (!navigator.onLine) { offline(); return Promise.resolve(); }
    var A = withSet.filter(function (r) { return r.num; });
    return postCollection(A.map(function (r) { return { set: r.set, collector_number: String(r.num) }; })).then(function (res) {
      if (res.failed) { offline(); return; }
      var map = {};
      res.cards.forEach(function (c) { map[c.set + '|' + String(c.collector_number).toLowerCase()] = c; });
      var again = withSet.filter(function (r) { return !r.num; });
      A.forEach(function (r) {
        var c = map[r.set + '|' + String(r.num).toLowerCase()];
        if (c && sameFront(c.name, r.name)) { r.edStatus = 'ok'; r.info = printInfo(c); r.num = c.collector_number; }
        else again.push(r);
      });
      if (!again.length) return;
      return postCollection(again.map(function (r) { return { name: String(r.name).split(' // ')[0], set: r.set }; })).then(function (r2) {
        again.forEach(function (r) {
          if (r2.failed) { r.edStatus = 'offline'; return; }
          var c = r2.cards.filter(function (x) { return x.set === r.set && sameFront(x.name, r.name); })[0];
          if (c) { r.edStatus = 'fixed'; r.info = printInfo(c); r.num = c.collector_number; } else r.edStatus = 'bad';
        });
      });
    });
  }
  function photoRead() {
    readPhotoInputs();
    if (photo.target === 'novo' && !photo.name.trim()) { photo.err = 'Dê um nome ao deck.'; render(); keepFocus('#pname'); return; }
    if (!photo.text.trim()) { photo.err = 'Cole aqui a resposta da IA.'; render(); keepFocus('#ptext'); return; }
    var parsed = FU.parseList(photo.text, true);
    if (!parsed.cards.length) { photo.err = 'Não achei cartas nessa resposta. Peça à IA para responder só com a lista, uma carta por linha, ex.: 1 Counterspell (TMP) 57.'; render(); keepFocus('#ptext'); return; }
    photo.err = ''; photo.busy = 'Conferindo nomes e edições…'; render();
    loadCatalog().then(function (idx) {
      photo.catalogMissing = !idx;
      photo.rows = buildPhotoRows(parsed.cards, idx || knownIndex());
      return verifyPrints(photo.rows);
    }).then(function () {
      photo.busy = ''; photo.step = 'review'; render(); window.scrollTo(0, 0);
    }).catch(function () {
      photo.busy = ''; photo.err = 'Não consegui conferir agora. Tente de novo.'; render();
    });
  }
  /* Foto vale como "tenho": só marca (nunca desmarca). O que passar da quantidade do deck vai para a Coleção. */
  function photoSave() {
    readPhotoReview();
    var rows = photo.rows.filter(function (r) { return r.qty > 0 && r.name; });
    if (!rows.length) { toast('Nenhuma carta para salvar.'); return; }
    var toColl = photo.target === 'colecao', groups = {}, order = [];
    rows.forEach(function (r) {
      var nm = canonical(r.name), board = toColl ? 'main' : r.board, k = board + '|' + FU.key(nm);
      if (!groups[k]) { groups[k] = { name: nm, board: board, qty: 0, eds: [] }; order.push(k); }
      var g = groups[k]; g.qty += r.qty;
      if (r.set && r.num && r.edStatus !== 'bad') {
        g.eds = FU.edsMerge(g.eds, [{ set: r.set, num: String(r.num), n: r.qty }]);
        if (r.info) { db.pr = db.pr || {}; db.pr[r.set + '/' + r.num] = r.info; }
      }
    });
    var deck = null, created = false;
    if (photo.target === 'novo') { deck = { id: newId(), name: photo.name.trim(), format: photo.format || 'Outro', cards: [], createdAt: Date.now() }; state.decks.push(deck); created = true; }
    else if (!toColl) deck = deckById(photo.target);
    if (!toColl && !deck) { toast('Deck não encontrado.'); return; }
    var marked = 0, extra = 0;
    order.forEach(function (k) {
      var g = groups[k];
      if (!deck) { putSpare(g.name, g.qty, g.eds); extra += g.qty; return; }
      var c = deck.cards.filter(function (x) { return x.board === g.board && FU.key(canonical(x.name)) === FU.key(g.name); })[0] ||
        deck.cards.filter(function (x) { return FU.key(canonical(x.name)) === FU.key(g.name); })[0];
      if (!c) { deck.cards.push({ name: g.name, qty: g.qty, board: g.board, owned: g.qty, eds: g.eds }); marked += g.qty; return; }
      var want = Math.min(g.qty, c.qty), before = c.owned || 0, tk = FU.edsTake(g.eds, want);
      c.owned = Math.max(before, want);
      c.eds = tk.taken;
      marked += c.owned - before;
      if (g.qty > want) { putSpare(g.name, g.qty - want, tk.rest); extra += g.qty - want; }
    });
    persist(true); persistDb();
    var names = order.map(function (k) { return groups[k].name; }).filter(function (n) { var i = cardInfo(n); return !i || !i.typeLine; });
    photo = null;
    goReplace(deck ? '#/deck/' + deck.id : '#/colecao');
    toast((created ? 'Deck criado. ' : '') + marked + (marked === 1 ? ' carta marcada' : ' cartas marcadas') + ' como “tenho”' + (extra ? ' · ' + extra + ' na Coleção' : '') + '.');
    if (names.length) refreshPrices({ only: names, silent: true });
  }


  /* ---------- metagame e confrontos (v0.21) ----------
     Dados de confronto vêm da IA do próprio usuário (um toque abre a IA com o pedido pronto) e ficam só no aparelho,
     com a data. Nada é lido automaticamente de sites; nada disso vai para o repositório público. */
  var metaUi = null;   // { text, err, parsed, busy }
  var muOpen = {};     // 'idDoDeck|adversário' -> aberto
  var ICO_X = svg('<path d="M6 6l12 12M18 6 6 18"/>');
  var ICO_WARN = svg('<path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01"/>');
  function archOf(d) { return d.arch || FU.suggestArch(d.name); }
  function todayStr() { var n = new Date(); return n.getFullYear() + '-' + ('0' + (n.getMonth() + 1)).slice(-2) + '-' + ('0' + n.getDate()).slice(-2); }
  function metaDateText(date) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
    return m ? m[3] + '/' + m[2] + '/' + m[1] : 'data não informada';
  }
  function premodernDecks() { return state.decks.filter(function (d) { return d.format === 'Premodern'; }); }
  function metaArchList() {
    var seen = {}, out = [];
    premodernDecks().forEach(function (d) { var a = archOf(d); if (a && !seen[a]) { seen[a] = 1; out.push(a); } });
    return out;
  }
  function metaPrompt() {
    var mine = metaArchList();
    return [
      'Preciso de dados de confronto do Premodern (Magic: The Gathering) para os meus decks.',
      'Meus arquétipos: ' + (mine.length ? mine.join(', ') : '(escolha no app)') + '.',
      'Para cada um, abra a página do arquétipo no MTG Decks (mtgdecks.net/Premodern, página do arquétipo, aba de winrates) e leia a tabela de taxa de vitória contra os outros decks.',
      'Inclua estes adversários, menos o próprio deck: ' + FU.META_ARCHS.join(', ') + '.',
      'Para cada adversário, anote a taxa de vitória do MEU deck contra ele e o número de partidas. Se a tabela for do adversário, inverta (100 menos o valor). Inclua também os de poucas partidas, com o número real de partidas.',
      'IMPORTANTE: devolva o resultado dentro de UM ÚNICO bloco de código (três crases), sem nenhum texto dentro dele, para eu tocar no botão de copiar do bloco e colar no app. Toda explicação fica fora do bloco. Formato:',
      'PLAYSET-META v1\nfonte: MTG Decks (mtgdecks.net/Premodern)\ndata: ' + todayStr() + '\ndeck: (nome do meu arquétipo)\nAdversário|taxa de vitória %|partidas',
      'Regras: use só números que estão na página, nunca estime nem invente. Se uma página não abrir ou não tiver a tabela, diga qual e peça para eu colar o texto ou um print da tabela. Sem explicações dentro do bloco.',
      'Se você tiver ferramenta de código, mostre depois do bloco também o link https://uxjesus.github.io/falta-uma/#/meta?d= seguido do bloco em base64url. Sem ferramenta de código, não tente gerar o link.'
    ].join('\n\n');
  }
  function openAi(ai, prompt, okMsg) {
    copyText(prompt, okMsg);
    var url = ai[2] + (ai[0] === 'gemini' ? '' : encodeURIComponent(prompt));
    if (url.length > 7000) url = ai[2];
    window.open(url, '_blank', 'noopener');
  }
  function metaSummaryLine() {
    var ks = state.meta && state.meta.decks ? Object.keys(state.meta.decks) : [];
    if (!ks.length) return 'Ainda sem dados salvos.';
    var last = ks.map(function (k) { return state.meta.decks[k].date || ''; }).sort().pop();
    return 'Dados salvos de ' + ks.length + (ks.length === 1 ? ' deck' : ' decks') + ' · mais recente: ' + metaDateText(last) + '.';
  }
  function viewMeta() {
    barAction.innerHTML = ''; fab.innerHTML = '';
    var q = route().query, m = /(?:^|&)d=([^&]+)/.exec(q || '');
    if (m) {
      metaUi = { text: '', err: '', parsed: null };
      try { metaUi.text = FU.b64urlDecode(m[1]); metaUi.parsed = FU.parseMeta(metaUi.text); if (!metaUi.parsed.rows) { metaUi.err = 'O link veio sem dados que eu consiga ler.'; metaUi.parsed = null; } }
      catch (e) { metaUi.err = 'Não consegui abrir os dados desse link. Cole o texto que a IA mandou no passo 3.'; }
      try { history.replaceState({ fu: navDepth, prev: curPrev }, '', '#/meta'); } catch (e2) {}
    }
    if (!metaUi) metaUi = { text: '', err: '', parsed: null };
    var html = '<header class="head"><a href="#/mais" class="link" style="margin-left:-4px" data-dropmeta data-goback>' + ICON.back + 'Voltar</a><h1>Importar winrates</h1></header>';
    if (metaUi.parsed) return html + (metaReviewHtml());
    var prem = premodernDecks(), noArch = prem.filter(function (d) { return !archOf(d); });
    var list = prem.length ? '<ul class="small" style="padding-left:20px">' + prem.map(function (d) { var a = archOf(d); return '<li>' + esc(d.name) + ' → ' + (a ? '<strong>' + esc(a) + '</strong>' : '<span style="color:var(--miss);font-weight:700">sem arquétipo (escolha no fim do deck)</span>') + '</li>'; }).join('') + '</ul>' : '<p class="small">Você ainda não tem deck Premodern. Crie um para ver os confrontos.</p>';
    html += '<div class="form pphoto">' +
      '<p class="small">' + esc(metaSummaryLine()) + '</p>' +
      '<section aria-labelledby="m0"><h2 id="m0" class="ph-h">Atualizar agora</h2>' +
      '<p class="small muted">O servidor do Playset lê os torneios Premodern recentes do <a href="https://topdeck.gg" target="_blank" rel="noopener">TopDeck.gg</a> toda semana. O app confere sozinho uma vez por dia. Os números são de torneios; confira antes de decisões grandes.</p>' +
      '<button type="button" class="btn primary full" data-mfetch>' + ICON.refresh + 'Atualizar agora</button></section>' +
      '<p class="small"><strong>Se a atualização falhar, use a sua IA em 3 passos.</strong></p>' +
      '<section aria-labelledby="m1"><h2 id="m1" class="ph-h"><span aria-hidden="true">1</span>Copie o pedido</h2>' +
      '<p class="small muted">O pedido já vai com os seus decks. A IA lê o MTG Decks e devolve só números da página.</p>' + list +
      '<button type="button" class="btn primary full" data-mcopy style="margin-top:8px"' + (prem.length ? '' : ' disabled') + '>' + ICON.copy + 'Copiar pedido</button>' +
      '<div class="aibtns">' + AIS.map(function (a) { return '<button type="button" class="btn" data-mai="' + a[0] + '"' + (prem.length ? '' : ' disabled') + '>Copiar e abrir ' + a[1] + '</button>'; }).join('') + '</div>' +
      (noArch.length ? '<p class="xs err" style="margin-top:8px">Falta escolher o arquétipo de ' + noArch.length + (noArch.length === 1 ? ' deck' : ' decks') + '. Eles ficam de fora do pedido.</p>' : '') + '</section>' +
      '<section aria-labelledby="m1b"><h2 id="m1b" class="ph-h"><span aria-hidden="true">2</span>Cole na sua IA</h2>' +
      '<p class="small muted">Abra a IA que você usa, cole o pedido e espere a resposta. Se a IA abrir sem o pedido preenchido, é só colar.</p></section>' +
      '<section aria-labelledby="m2"><h2 id="m2" class="ph-h"><span aria-hidden="true">3</span>Cole a resposta ou a tabela aqui</h2>' +
      '<p class="small muted">Cole o bloco que a IA mandou. Se a IA não conseguiu abrir alguma página, abra você a página do deck em mtgdecks.net/Premodern no Chrome, copie a tabela de winrates e cole abaixo: o app lê sozinho.</p>' +
      '<label for="march" class="small" style="display:block;margin-top:8px"><strong>Se for a tabela de uma página do site, de qual deck ela é?</strong></label>' +
      '<select id="march" class="field" style="margin-top:4px"><option value="">Escolher…</option>' + FU.META_ARCHS.map(function (a) { return '<option' + (metaUi.arch === a ? ' selected' : '') + '>' + esc(a) + '</option>'; }).join('') + '</select>' +
      '<label for="mtext" class="visually-hidden">Resposta da IA</label><textarea id="mtext" spellcheck="false" autocapitalize="off" placeholder="PLAYSET-META v1&#10;fonte: MTG Decks&#10;data: 2026-11-19&#10;deck: Burn&#10;Stiflenought|26|50" style="margin-top:8px">' + esc(metaUi.text) + '</textarea>' +
      '<p id="mErr" class="err" role="alert" style="margin-top:8px">' + esc(metaUi.err) + '</p>' +
      '<button type="button" class="btn primary full" data-mread style="margin-top:8px">Ler dados</button></section>' +
      (state.meta && state.meta.decks && Object.keys(state.meta.decks).length ? '<button type="button" class="btn full" data-mclear>Apagar os dados salvos</button>' : '') +
      '<p class="xs muted">Os dados ficam só neste aparelho (e no seu backup), com a data. A fonte é o MTG Decks; confira lá antes de decisões grandes.</p></div>';
    return html;
  }
  function metaReviewHtml() {
    var p = metaUi.parsed, ks = Object.keys(p.decks);
    return '<div class="form" style="gap:12px"><p class="small">Li <strong>' + p.rows + (p.rows === 1 ? ' linha' : ' linhas') + '</strong> de <strong>' + ks.length + (ks.length === 1 ? ' deck' : ' decks') + '</strong>' +
      (p.skipped.length ? ' e ignorei ' + p.skipped.length + (p.skipped.length === 1 ? ' linha' : ' linhas') + ' que não entendi' : '') + '.</p>' +
      '<ul class="small" style="padding-left:20px">' + ks.map(function (k) { return '<li><strong>' + esc(k) + '</strong>: ' + p.decks[k].length + ' adversários, ' + p.decks[k].filter(function (r) { return r.n >= FU.META_MIN; }).length + ' com ' + FU.META_MIN + '+ partidas</li>'; }).join('') + '</ul>' +
      '<p class="small">Data dos dados: <strong>' + esc(p.date ? metaDateText(p.date) : (p.table ? 'hoje, ' + metaDateText(todayStr()) + ' (dia em que você copiou)' : 'não informada (vou usar hoje, ' + metaDateText(todayStr()) + ')')) + '</strong>' + (p.source ? ' · ' + esc(p.source) : '') + '</p>' +
      (p.table ? '<p class="small"><span class="chip mid">Inferência</span> A página não diz de quem é a taxa. Pelo título "Premodern ' + esc(Object.keys(p.decks)[0]) + ' winrates", entendo que é do <strong>seu deck contra o adversário</strong>. Confira: na página do adversário, o seu deck deve aparecer com a taxa invertida (100 menos o valor), com número de partidas parecido.</p>' : '') +
      (ks.some(function (k) { return !FU.META_ARCHS.some(function (a) { return FU.key(a) === FU.key(k); }); }) ? '<p class="xs muted">Há decks com nome fora da lista do app. Eles são salvos, mas só aparecem se o arquétipo do seu deck tiver o mesmo nome.</p>' : '') +
      '<button type="button" class="btn primary full" data-msave>Salvar no app</button>' +
      '<button type="button" class="btn full" data-mback>Voltar e editar o texto</button></div>';
  }
  function metaRead() {
    var x = document.getElementById('mtext'); var text = x ? x.value : metaUi.text;
    metaUi.text = text;
    var sel = document.getElementById('march'); if (sel) metaUi.arch = sel.value;
    var p = FU.parseMeta(text);
    if (!p.rows) {
      var tb = FU.parseMetaTable(text), arch = metaUi.arch || tb.arch || '';
      if (tb.rows) {
        if (!arch) { metaUi.err = 'Isto parece a tabela de uma página do MTG Decks. Escolha de qual deck ela é, no campo logo acima.'; render(); keepFocus('#march'); return; }
        var dk = {}; dk[arch] = tb.list;
        metaUi.err = ''; metaUi.parsed = { date: null, source: 'MTG Decks (tabela copiada do site)', decks: dk, rows: tb.rows, skipped: tb.skipped, table: true }; render(); return;
      } metaUi.err = 'Não encontrei nenhuma linha no formato Adversário|taxa|partidas. Confira se colou o bloco inteiro.'; render(); keepFocus('#mtext'); return; }
    metaUi.err = ''; metaUi.parsed = p; render();
  }
  function metaSave() {
    var p = metaUi && metaUi.parsed; if (!p) return;
    var date = p.date || todayStr();
    state.meta = state.meta || { decks: {} };
    state.meta.decks = state.meta.decks || {};
    Object.keys(p.decks).forEach(function (k) {
      var old = Object.keys(state.meta.decks).filter(function (x) { return FU.key(x) === FU.key(k); })[0];
      if (old && old !== k) delete state.meta.decks[old];
      state.meta.decks[k] = { date: date, source: p.source || 'MTG Decks', savedAt: Date.now(), rows: p.decks[k] };
    });
    persist(true);
    metaUi = null;
    goReplace('#/mais');
    toast('Dados de confronto salvos.');
  }
  /* Dados do servidor (TopDeck.gg, atualizados toda semana). Só troca um deck se o dado do servidor for mais novo que o salvo. */
  var META_AUTO_MS = 24 * 60 * 60 * 1000;
  var TOPDECK_SRC = 'TopDeck.gg (topdeck.gg), servidor do Playset';
  function metaApplyServer(j) {
    var changed = 0; state.meta = state.meta || { decks: {} }; state.meta.decks = state.meta.decks || {};
    var date = /^\d{4}-\d{2}-\d{2}$/.test(j.data || '') ? j.data : todayStr();
    /* Nomes que o servidor deixou de usar (ex.: trocou a tabela de nomes) não ficam sobrando no aparelho. */
    Object.keys(state.meta.decks).forEach(function (x) {
      var e = state.meta.decks[x];
      if (e && /^TopDeck\.gg/.test(e.source || '') && !Object.keys(j.decks).some(function (k) { return FU.key(k) === FU.key(x); })) delete state.meta.decks[x];
    });
    Object.keys(j.decks).forEach(function (k) {
      var rows = (j.decks[k] || []).map(function (r) { return { o: String(r.opp), wr: Number(r.wr), n: Math.floor(Number(r.n)) }; })
        .filter(function (r) { return r.o && isFinite(r.wr) && r.wr >= 0 && r.wr <= 100 && r.n > 0; });
      if (!rows.length) return;
      var old = Object.keys(state.meta.decks).filter(function (x) { return FU.key(x) === FU.key(k); })[0];
      if (old && (state.meta.decks[old].date || '') > date) return;
      if (old && /^Duress/.test(state.meta.decks[old].source || '')) return;
      if (old) delete state.meta.decks[old];
      state.meta.decks[k] = { date: date, source: j.fonte || TOPDECK_SRC, savedAt: Date.now(), rows: rows };
      changed++;
    });
    return changed;
  }
  /* Winrates da Duress Crew vêm junto com o app (logic.js). Valem para qualquer deck Premodern novo, mesmo offline.
     Não trocam o que a pessoa importou à mão de uma data igual ou mais nova. */
  function duressApply() {
    var D = FU.DURESS, n = 0; if (!D) return 0;
    state.meta = state.meta || { decks: {} }; state.meta.decks = state.meta.decks || {};
    Object.keys(D.decks).forEach(function (k) {
      var old = Object.keys(state.meta.decks).filter(function (x) { return FU.key(x) === FU.key(k); })[0], e = old && state.meta.decks[old];
      if (e && e.source === D.source && e.date === D.date) return;
      if (e && e.source !== D.source && !/^TopDeck\.gg/.test(e.source || '') && (e.date || '') >= D.date) return;
      if (old) delete state.meta.decks[old];
      state.meta.decks[k] = { date: D.date, source: D.source, savedAt: Date.now(), rows: D.decks[k].map(function (r) { return { o: r.o, wr: r.wr, n: r.n }; }) };
      n++;
    });
    return n;
  }
  function metaFetch(silent) {
    if (!navigator.onLine) { if (!silent) toast('Sem internet.'); return Promise.resolve(false); }
    return fetch(SYNC_URL + 'meta?format=Premodern').then(function (r) { return r.json().catch(function () { return null; }); }).then(function (j) {
      if (!j || !j.decks) { if (!silent) toast('O servidor ainda não tem dados.' + (j && j.err ? ' Motivo: ' + j.err : ' Tente mais tarde.')); return false; }
      var n = metaApplyServer(j);
      state.metaFetchAt = Date.now();
      persist(n > 0);
      if (!silent) toast(n ? 'Dados atualizados (' + n + (n === 1 ? ' deck).' : ' decks).') : 'Você já tem os dados mais novos.');
      if (n && (route().name === 'meta' || route().name === 'deck' || route().name === 'mais')) { var y = window.scrollY; render(); window.scrollTo(0, y); }
      return true;
    }).catch(function () { if (!silent) toast('Não consegui falar com o servidor.'); return false; });
  }
  if (duressApply()) persist(true);
  setTimeout(function () { if (premodernDecks().length && (!state.metaFetchAt || Date.now() - state.metaFetchAt > META_AUTO_MS)) metaFetch(true); }, 1500);
  function collLookup() {
    var m = {}; collectionData().forEach(function (r) { m[FU.key(r.name)] = r; });
    return function (n) { return m[FU.key(canonical(n))] || null; };
  }
  function chip(kind, text) { return '<span class="chip ' + kind + '">' + (kind === 'no' ? ICO_X : (kind === 'mid' ? ICO_WARN : ICO.check)) + esc(text) + '</span>'; }
  function noteStatusChip(s) {
    if (s.where === 'side') return chip(s.have >= s.qty ? 'ok' : (s.have ? 'mid' : 'no'), 'No seu sideboard · ' + (s.have >= s.qty ? 'você tem' : (s.have ? 'tem ' + s.have + ' de ' + s.qty : 'ainda não tem')));
    if (s.where === 'main') return chip(s.have ? 'mid' : 'no', 'No seu deck principal · ' + (s.have ? 'você tem' : 'ainda não tem'));
    if (s.where === 'colecao') return chip('ok', s.spare ? 'Na sua coleção, fora dos decks (' + s.spare + ')' : 'Está em outro deck ou lista sua (' + s.have + ')');
    return chip('no', 'Você não tem');
  }
  function deckLines(d, side) {
    return d.cards.filter(function (c) { return side ? c.board === 'side' : c.board !== 'side'; })
      .map(function (c) { return c.qty + ' ' + canonical(c.name) + (c.owned < c.qty && !FU.isBasic(c.name) ? ' (tenho ' + (c.owned || 0) + ')' : ''); }).join('\n') || '(vazio)';
  }
  function matchupAiPrompt(d, arch, r, date) {
    var spare = collectionData().filter(function (x) { return x.spare > 0; }).slice(0, 200).map(function (x) { return x.spare + ' ' + x.name; }).join('\n') || '(nenhuma)';
    return [
      'Sou jogador de Premodern (Magic: The Gathering). Meu deck é "' + d.name + '" (arquétipo ' + arch + ').',
      'Contra ' + r.o + (r.wr == null ? '' : ', a taxa de vitória do meu arquétipo é ' + r.wr + '% em ' + r.n + ' partidas (MTG Decks, dados de ' + metaDateText(date) + ')') + '. Quero sugestões de sideboard para esse confronto.',
      'Meu deck principal:\n' + deckLines(d, false),
      'Meu sideboard:\n' + deckLines(d, true),
      'Cartas que eu tenho fora dos decks (coleção):\n' + spare,
      'IMPORTANTE: pesquise guias, listas de torneio e discussões (fóruns, Reddit, Discord público) e devolva o plano dentro de UM ÚNICO bloco de código (três crases), no formato abaixo, para eu tocar no botão de copiar. Toda explicação fica fora do bloco.\nFormato do bloco:\nADVERSARIO: ' + r.o + '\nENTRA:\n<quantidade> <carta>\nSAI:\n<quantidade> <carta>\nNOTAS:\n- <motivo curto de cada troca, e o que eu não tenho, se houver>\nFONTE: <links e datas>',
      'Regras:\n1. Diga o que TIRAR e o que COLOCAR, mantendo 60 cartas no principal e 15 no sideboard.\n2. Use SÓ cartas do meu deck, do meu sideboard ou da minha coleção. Se uma carta muito boa não estiver em nenhuma, cite-a em NOTAS como "você não tem".\n3. Em FONTE, os links e as datas. Em NOTAS, marque como "inferência" o que for raciocínio seu e não vier de uma fonte.\n4. Com menos de 30 partidas, diga que o número é só uma pista. Se não achar fontes boas, diga isso em vez de inventar.\n5. Explique em passos curtos, em português.'
    ].join('\n\n');
  }
  function planHtml(d, note, lookup) {
    var qn = function (x) { return (x.q ? x.q + '× ' : '') + esc(x.name); };
    var sum = function (a) { return a.reduce(function (t, x) { return t + (x.q || 0); }, 0); };
    var h = !note.plan.in.length ? '' : '<p class="small"><strong>Entra</strong></p><ul class="mu-cards">' + note.plan.in.map(function (x) {
      return '<li><span class="nm">' + qn(x) + '</span> ' + noteStatusChip(FU.noteCardStatus(x.name, d, canonical, lookup)) + '</li>'; }).join('') + '</ul>';
    if (note.plan.out.length) h += '<p class="small"><strong>Sai</strong></p><ul class="mu-cards">' + note.plan.out.map(function (x) {
      var kk = FU.key(canonical(x.name)), inMain = d.cards.filter(function (c) { return c.board !== 'side' && c.board !== 'maybe' && FU.key(canonical(c.name)) === kk; }).reduce(function (t, c) { return t + c.qty; }, 0);
      return '<li><span class="nm">' + qn(x) + '</span> ' + (!inMain ? chip('mid', 'Não achei no seu principal: ignore essa troca') : (x.q && inMain < x.q ? chip('mid', 'Você tem só ' + inMain + ' no principal') : chip('ok', 'No seu deck principal'))) + '</li>'; }).join('') + '</ul>';
    return h + '<p class="xs">' + (note.partial ? 'O guia só nomeia parte das trocas, sem quantidades.' : 'Entram ' + sum(note.plan.in) + ' · saem ' + sum(note.plan.out) + '. As trocas são as do autor para a lista dele: confira com a sua.') + '</p>';
  }
  function userNote(d, opp) {
    var gk = guideKey(d, opp), u = d.mu && Object.prototype.hasOwnProperty.call(d.mu, gk) ? d.mu[gk] : null;
    return u ? { plan: u.plan && (u.plan.in.length || u.plan.out.length) ? u.plan : null, lines: u.lines || [], src: u.src || [], partial: !!u.partial, unreadable: u.unreadable || 0, user: true } : null;
  }
  function matchupPanel(d, arch, r, date, user) {
    if (!user && !FU.sideNote(arch, r.o) && d.mu && Object.prototype.hasOwnProperty.call(d.mu, guideKey(d, r.o))) user = true;
    var note = user ? userNote(d, r.o) : FU.sideNote(arch, r.o), lookup = collLookup();
    var h = '<div class="mu-panel"><p class="small"><strong>' + esc(arch) + ' × ' + esc(r.o) + '</strong>' + (r.wr == null ? '' : ': ' + r.wr + '% em ' + r.n + ' partidas' + (r.n < FU.META_SMALL ? ' (amostra pequena: use como pista)' : '')) + '.</p>';
    if (note) {
      h += note.lines.map(function (l) { return '<p class="small">' + esc(l) + '</p>'; }).join('');
      if (note.plan) {
        h += planHtml(d, note, lookup);
      } else if (note.in && note.in.length) {
        h += '<p class="small"><strong>Cartas que o guia sugere trazer</strong></p><ul class="mu-cards">' + note.in.map(function (n) {
          return '<li><span class="nm">' + esc(n) + '</span> ' + noteStatusChip(FU.noteCardStatus(n, d, canonical, lookup)) + '</li>'; }).join('') + '</ul>';
      }
      if (note.expect) h += '<p class="small">' + esc(note.expect) + '</p>';
      if (note.infer) h += '<p class="small"><span class="chip mid">Inferência</span> ' + esc(note.infer.replace(/^Inferência minha:\s*/, '')) + '</p>';
      if (note.unreadable) h += '<p class="small">' + chip('mid', note.unreadable + (note.unreadable === 1 ? ' linha ilegível' : ' linhas ilegíveis') + ' no print') + ' Confira no original.</p>';
      h += '<p class="xs">' + (note.src.length ? 'Fontes: ' + note.src.map(function (s) { return s.url ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.label) + '</a> (' + (s.date ? metaDateText(s.date) : 'sem data na página') + ')' : esc(s.label); }).join(' · ') : 'Fonte não informada no print.') + '</p>';
    } else {
      h += '<p class="small">Ainda não tenho um guia conferido para este confronto, e não vou inventar. Peça à sua IA: o pedido já vai com o seu deck, o seu sideboard e a sua coleção.</p>';
    }
    if (user) return h + '<p class="xs">Guia que você importou de um print, lido pela sua IA. Confira com o original.</p><button type="button" class="btn full" data-gdelmu="' + esc(d.id) + '|' + esc(r.o) + '">Remover este guia</button></div>';
    h += '<button type="button" class="btn primary full" data-muai="' + esc(d.id) + '|' + esc(r.o) + '">Pedir sugestão à IA e guardar a resposta</button>' +
      '<p class="xs"><a class="lnk" href="https://mtgdecks.net/Premodern/' + esc(encodeURIComponent(arch.toLowerCase().replace(/\s+/g, '-'))) + '" target="_blank" rel="noopener">Abrir ' + esc(arch) + ' no MTG Decks</a></p></div>';
    return h;
  }
  /* Guias conferidos que não dependem de winrates: abrem direto, mesmo sem dados do servidor. */
  var muShown = {};
  function guideRows(d, arch, skip, title, few) {
    var opps = FU.sideNotesFor(arch).filter(function (o) { return !skip[o]; });
    if (!opps.length) return '';
    opps.forEach(function (o) { muShown[FU.noAcc(o)] = true; });
    var h = '<h3 class="small" style="margin-top:8px"><strong>' + esc(title) + '</strong></h3>';
    opps.forEach(function (o) {
      var id = d.id + '|' + o, open = !!muOpen[id];
      h += '<button type="button" class="mu-row" data-mu="' + esc(id) + '" aria-expanded="' + open + '"><span class="o">' + esc(o) + '</span><span class="w">Guia</span>' +
        '<span class="s">' + (few && few[o] ? 'só ' + few[o] + ' partidas nos dados' : 'sem winrate') + ' · toque para ver ' + (FU.sideNote(arch, o).plan ? 'o plano de sideboard' : 'as cartas do guia') + '</span></button>' + (open ? matchupPanel(d, arch, { o: o, wr: null, n: null }, null) : '');
    });
    return h;
  }


  /* ---------- Em consideração: cartas que talvez entrem no deck ---------- */
  function consNeedOf(d) { return FU.considerNeed(d, spareQty); }
  var poolOpen = '';
  function considerHtml(d) {
    if (d.format === 'Lista') return '';
    var list = d.consider || [], id = esc(d.id), need = consNeedOf(d), val = 0;
    list.forEach(function (c) { var b = unitBrl(cardInfo(c.name)); if (b != null) val += b * Math.max(0, c.qty - Math.min(c.qty, spareQty(c.name))); });
    var h = '<section class="card pad stack cons" aria-labelledby="csH" style="margin:16px"><h2 id="csH" tabindex="-1" style="font-size:1.0625rem">Em consideração' + (list.length ? ' <span class="muted">(' + list.length + ')</span>' : '') + '</h2>' +
      '<p class="small muted">Cartas que talvez entrem. Já vêm as que aparecem nas suas fontes. Marque <strong>Tenho</strong> quando tiver. Contam em “O que me falta” e no preço, mas não no selo “Completo”.</p>' +
      '<label for="acIn" class="visually-hidden">Buscar carta para adicionar</label>' +
      '<div class="acrow"><input type="text" id="acIn" data-acdeck="' + id + '" data-acmode="consider" autocomplete="off" spellcheck="false" autocapitalize="off" enterkeyhint="search" placeholder="Buscar carta (inglês ou português)" aria-describedby="acHelp" aria-controls="acList">' +
      '<button type="button" class="btn primary" data-acgo>' + ICON.plus + 'Adicionar</button></div>' +
      '<p class="xs muted" id="acHelp">Entra 1 cópia aqui. Para pôr direto no deck, toque no ⋯ da carta e escolha “Pôr no deck”.</p>' +
      '<p class="visually-hidden" id="acLive" aria-live="polite"></p><ul class="aclist" id="acList"></ul>';
    var liveCons = consLive(d);
    if (list.length) {
      h += '<ul class="rows cons-rows">' + list.map(function (c, i) {
        var have = Math.min(c.qty, spareQty(c.name)), info = cardInfo(c.name), pr = moneyShort(info, 1), ref = id + '|' + i + '|' + esc(c.name), nm = esc(c.name);
        var lv = c.auto ? liveCons[FU.key(canonical(c.name))] : null, why = lv ? 'aparece em ' + lv.cnt + ' de ' + lv.tot : (c.auto && c.cnt ? 'aparece em ' + c.cnt + ' de ' + c.tot : '');
        var cls = have >= c.qty ? 'done' : (have > 0 ? 'part' : 'none');
        return '<li class="r"><span class="q' + (have >= c.qty ? '' : ' miss') + '">' + c.qty + '</span>' +
          '<button class="nm" data-card="' + nm + '">' + esc(canonical(c.name)) + '<span class="d">' + (c.board === 'side' ? 'sideboard' : 'principal') + (why ? ' · ' + why : '') + (pr ? ' · ' + pr + ' cada' : '') + '</span></button>' +
          rowTools(info, c.name) +
          '<span class="ra"><button class="own ' + cls + '" data-conshave="' + ref + '" aria-pressed="' + (have >= c.qty) + '" aria-label="Tenho ' + have + ' de ' + c.qty + ' ' + nm + '. Tocar para marcar ' + (have >= c.qty ? 'nenhuma' : 'todas') + '"><i>' + (have >= c.qty ? '✓' : have + '/' + c.qty) + '</i></button>' +
          '<button class="ib" data-consmenu="' + ref + '" aria-label="Mais ações para ' + nm + ': pôr no deck, trocar ou remover">' + svg('<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>') + '</button></span></li>';
      }).join('') + '</ul>';
      var ca = consAllList(d);
      if (ca.length >= 2) h += '<button type="button" class="btn full" data-consall="' + id + '">' + ICON.plus + 'Pôr no deck as ' + ca.length + ' que estão em todas as fontes</button>';
      if (need) h += '<p class="small"><strong>Faltam ' + need + (need === 1 ? ' carta' : ' cartas') + '</strong>' + (val ? ' · ≈ ' + brl0.format(val) : '') + ' desta lista.</p>';
    }
    var pool = FU.considerPool(d, canonical), srcN = (d.sources || []).filter(function (x) { return x.cards && x.cards.length; }).length;
    if (!list.length) h += '<p class="small">' + (!srcN ? ((d.sources || []).length ? '<strong>As ' + d.sources.length + (d.sources.length === 1 ? ' fonte é só um link' : ' fontes são só links') + ', sem cartas lidas.</strong> Eu só comparo listas que tenham as cartas (texto colado ou lido de print). Cole a lista com as cartas em Fontes, abaixo.' : '<strong>Este deck não tem fontes.</strong> Adicione listas em Fontes, abaixo, e as cartas delas aparecem aqui. Você também pode buscar uma carta acima.')
      : (pool.length ? 'Nenhuma carta apareceu em 2 ou mais das suas ' + srcN + (srcN === 1 ? ' lista' : ' listas') + '. As que aparecem em uma só estão logo abaixo.'
        : 'Todas as cartas das suas ' + srcN + (srcN === 1 ? ' lista' : ' listas') + ' já estão no deck ou foram removidas daqui.')) + '</p>';
    if (pool.length) {
      var poolSorted = pool.slice().sort(function (a, b) { return b.count - a.count || (a.board === b.board ? 0 : (a.board === 'main' ? -1 : 1)) || a.name.localeCompare(b.name); });
      h += '<details class="small" open id="consPool"><summary style="min-height:44px;display:flex;align-items:center;cursor:pointer"><strong>' + (list.length ? 'Aparecem em uma fonte só' : 'Cartas das suas fontes') + ' (' + pool.length + ')</strong></summary>' +
        '<p class="xs muted">Toque no + para guardar a carta em Em consideração. As que você não quiser, é só ignorar.</p><ul class="rows cons-rows">' +
        poolSorted.slice(0, 40).map(function (c) {
          var info = cardInfo(c.name);
          return '<li class="r"><span class="q" aria-label="em ' + c.count + ' de ' + c.total + ' fontes" style="font-size:.8125rem;color:var(--muted)">' + c.count + '/' + c.total + '</span>' +
            '<button class="nm" data-card="' + esc(c.name) + '">' + esc(canonical(c.name)) + '<span class="d">' + c.qty + ' cópia' + (c.qty > 1 ? 's' : '') + (c.board === 'side' ? ' · sideboard' : '') + '</span></button>' +
            rowTools(info, c.name) +
            '<span class="ra"><button class="own" data-conspool="' + id + '|' + esc(c.name) + '" aria-label="Adicionar ' + esc(canonical(c.name)) + ' à lista Em consideração"><i style="border-color:var(--accent);color:var(--accent)">+</i></button></span></li>';
        }).join('') + '</ul>' + (pool.length > 40 ? '<p class="xs muted">Mostrando 40 das ' + pool.length + '. Ao pôr algumas no deck ou na lista, as outras aparecem.</p>' : '') + '</details>';
    }
    return h + sourcesHtml(d) + '</section>';
  }
  /* Acha a carta da lista pelo índice E pelo nome: se a lista mudou desde que a tela foi desenhada, não age na carta errada. */
  function consEntry(d, idx, name) {
    var e = d && (d.consider || [])[idx];
    return e && FU.key(e.name) === FU.key(name) ? e : null;
  }
  /* Cartas de "Em consideração" que aparecem em todas as fontes lidas (2 ou mais fontes): candidatas ao lote. */
  /* Contagem ao vivo (em quantas das fontes lidas a carta aparece): os números guardados na carta ficam velhos quando entra outra fonte depois. */
  function consLive(d) {
    var m = {};
    FU.consensus(d.sources || []).forEach(function (c) { m[FU.key(canonical(c.name))] = { cnt: c.count, tot: c.total }; });
    return m;
  }
  function consAllList(d) {
    var live = consLive(d);
    return (d.consider || []).map(function (e, i) { return { i: i, e: e, l: live[FU.key(canonical(e.name))] }; }).filter(function (x) { return x.e.auto && x.l && x.l.tot > 1 && x.l.cnt === x.l.tot; });
  }
  function consAllSheet(d) {
    var l = consAllList(d);
    if (l.length < 2) return '<p>A lista mudou. Feche e abra de novo.</p>';
    return '<h2 id="sheetTitle">Pôr ' + l.length + ' cartas no deck?</h2>' +
      '<p class="small">São as cartas que aparecem em todas as suas fontes lidas. Entram na quantidade sugerida e saem da lista Em consideração.</p>' +
      '<ul class="menu">' + l.map(function (x) { return '<li><span style="display:block;padding:10px 0">' + x.e.qty + '× ' + esc(canonical(x.e.name)) + ' <span class="muted small">· ' + (x.e.board === 'side' ? 'sideboard' : 'principal') + '</span></span></li>'; }).join('') + '</ul>' +
      '<p class="xs muted">Para desfazer uma carta, toque nela no deck e escolha “Tirar do deck”.</p>' +
      '<button type="button" class="btn primary full" data-callgo style="margin-top:8px">Pôr ' + l.length + ' cartas no deck</button>' +
      '<button type="button" class="btn full" data-callno style="margin-top:8px">Cancelar</button>';
  }
  function consToDeck(dd, idx, name) {
    var de = consEntry(dd, idx, name); if (!de) return null;
    var dn = de.name, dq = de.qty, db2 = de.board === 'side' ? 'side' : 'main';
    var dx = dd.cards.filter(function (x) { return x.board === db2 && FU.key(canonical(x.name)) === FU.key(canonical(dn)); })[0];
    if (dx) setQty(dx, dx.qty + dq); else addToDeck(dd, dn, dq, db2);
    dd.consider.splice(idx, 1); if (!dd.consider.length) delete dd.consider;
    return { name: dn, board: db2 };
  }
  function consDrop(rd, idx, name) {
    var re = consEntry(rd, idx, name); if (!re) return null;
    rd.consider.splice(idx, 1); if (!rd.consider.length) delete rd.consider;
    rd.consNo = (rd.consNo || []).concat([re.name]).slice(-200);
    return re;
  }
  function considerActionSheet(d, e, ref) {
    var nm = esc(e.name), bd = e.board === 'side' ? 'sideboard' : 'deck';
    return '<h2 id="sheetTitle">' + e.qty + '× ' + nm + '</h2><ul class="menu">' +
      '<li><button type="button" data-cadeck><span>Pôr no ' + bd + '<small>Entra no deck e sai desta lista</small></span></button></li>' +
      '<li><button type="button" data-caswap><span>Trocar por uma carta do deck<small>A que sair vai para esta lista</small></span></button></li>' +
      '<li><button type="button" data-carm><span>Remover da lista<small>Não volta a ser sugerida</small></span></button></li></ul>';
  }
  function considerSwapSheet(d, e) {
    var rows = ['main', 'side'].map(function (b) {
      var cs = d.cards.map(function (c, i) { return { c: c, i: i }; }).filter(function (x) { return x.c.board === b && !FU.isBasic(x.c.name) && FU.key(canonical(x.c.name)) !== FU.key(canonical(e.name)); });
      if (!cs.length) return '';
      cs.sort(function (a, z) { return a.c.name.localeCompare(z.c.name); });
      return '<p class="small" style="margin-top:8px"><strong>' + (b === 'side' ? 'Sideboard' : 'Principal') + '</strong></p><ul class="menu">' + cs.map(function (x) {
        return '<li><button type="button" data-swout="' + x.i + '"><span>' + x.c.qty + '× ' + esc(x.c.name) + '<small>Sai ' + Math.min(e.qty, x.c.qty) + (Math.min(e.qty, x.c.qty) === 1 ? ' cópia' : ' cópias') + ', entra ' + esc(e.name) + '</small></span></button></li>';
      }).join('') + '</ul>';
    }).join('');
    return '<h2 id="sheetTitle">Trocar ' + esc(e.name) + '</h2><p class="small muted">Escolha a carta do deck que sai. Ela vai para “Em consideração”, então dá para desfazer trocando de volta.</p>' + (rows || '<p class="small">O deck não tem cartas para trocar.</p>');
  }
  function considerSwap(d, ci, cardIdx) {
    var e = (d.consider || [])[ci], c = d.cards[cardIdx];
    if (!e || !c || c.board === 'commander' || FU.key(canonical(c.name)) === FU.key(canonical(e.name))) return null;
    var k = Math.min(e.qty, c.qty), inName = e.name, outName = c.name, board = c.board;
    var ex = d.cards.filter(function (x) { return x !== c && x.board === board && FU.key(canonical(x.name)) === FU.key(canonical(inName)); })[0];
    if (ex) setQty(ex, ex.qty + k); else addToDeck(d, inName, k, board);
    if (k >= c.qty) removeCard(d, d.cards.indexOf(c)); else setQty(c, c.qty - k);
    if (e.qty > k) e.qty -= k; else d.consider.splice(ci, 1);
    FU.considerAdd(d, outName, k, board, canonical);
    return { k: k, inName: inName, outName: outName };
  }

  /* ---------- "Como jogar" (primer) e importação de guias pela IA da pessoa ---------- */
  function primerHtml(d) {
    if (d.format === 'Lista') return '';
    var p = d.primer, id = esc(d.id);
    if (!p || !p.lines || !p.lines.length) {
      return '<section class="primer empty" aria-labelledby="pmH"><h2 id="pmH">Como jogar com este deck</h2>' +
        '<p class="small">Guarde aqui o plano de jogo: mulligan, combos, o que fazer em cada fase. Tire print de um guia, a sua IA lê e o app guarda.</p>' +
        '<button type="button" class="btn full" data-guide="' + id + '">Importar de um guia, pela IA</button></section>';
    }
    var li = function (a) { return a.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join(''); };
    var first = p.lines.slice(0, 4), rest = p.lines.slice(4);
    return '<section class="primer" aria-labelledby="pmH"><div class="ph"><h2 id="pmH" tabindex="-1">Como jogar</h2><span class="xs">primer do deck</span></div>' +
      '<ul class="plist">' + li(first) + '</ul>' +
      (rest.length ? '<details class="small"><summary style="min-height:44px;display:flex;align-items:center;cursor:pointer"><strong>Ler tudo (+' + rest.length + ')</strong><span class="xs muted">&nbsp;· toque para abrir</span></summary><ul class="plist">' + li(rest) + '</ul></details>' : '') +
      '<p class="xs">' + (p.src ? 'Fonte: ' + esc(p.src) : 'Fonte não informada no print') + ' · importado de um print: confira com o original.</p>' +
      '<div class="pact"><button type="button" class="btn" data-guide="' + id + '">Importar outro</button><button type="button" class="btn" data-primerdel="' + id + '">Remover</button></div></section>';
  }
  var guideText = '', guideDraft = null, guideMu = null;
  function guideCurrentPrompt(d) { return guideMu ? matchupAiPrompt(d, guideMu.arch, guideMu.r, guideMu.date) : FU.guidePrompt(guideDeckInfo(d)); }
  function guideDeckInfo(d) { return { name: d.name, arch: d.format === 'Premodern' ? archOf(d) : '', format: d.format, main: deckLines(d, false), side: deckLines(d, true) }; }
  function guideInputHtml(d) {
    return '<h2 id="sheetTitle">' + (guideMu ? 'Sugestão da IA: contra ' + esc(guideMu.r.o) : 'Importar guia pela IA') + '</h2>' +
      '<ol class="small" style="padding-left:20px;display:grid;gap:6px"><li>Toque em <strong>Copiar pedido</strong>.</li><li>Cole na sua IA' + (guideMu ? '.' : ' e anexe o print do guia.') + '</li><li>Copie a resposta e cole aqui embaixo.</li></ol>' +
      '<button type="button" class="btn primary full" data-gcopy style="margin-top:8px">' + ICON.copy + 'Copiar pedido</button>' +
      '<button type="button" class="btn full" data-gai style="margin-top:8px">Copiar e abrir ' + AIS[0][1] + '</button>' +
      '<label for="gIn" class="small" style="display:block;margin-top:16px"><strong>Resposta da IA</strong></label>' +
      '<textarea id="gIn" aria-describedby="gMsg" spellcheck="false" autocapitalize="off" style="min-height:160px;margin-top:6px">' + esc(guideText) + '</textarea>' +
      '<p class="xs muted" id="gMsg" role="status" style="margin-top:6px"></p>' +
      '<button type="button" class="btn primary full" data-gcheck style="margin-top:8px">Conferir</button>';
  }
  function guidePreviewHtml(d, g) {
    var lookup = collLookup(), h = '<h2 id="sheetTitle" tabindex="-1">Conferir antes de salvar</h2>';
    if (g.primer) {
      h += '<section class="gp"><h3 class="small"><strong>Como jogar</strong> · ' + g.primer.notes.length + (g.primer.notes.length === 1 ? ' tópico' : ' tópicos') + (d.primer ? ' · substitui o atual' : '') + '</h3><ul class="plist">' +
        g.primer.notes.slice(0, 3).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
        (g.primer.notes.length > 3 ? '<p class="xs muted">e mais ' + (g.primer.notes.length - 3) + '.</p>' : '') +
        (g.primer.src ? '<p class="xs muted">Fonte: ' + esc(g.primer.src) + '</p>' : '<p class="xs muted">Sem fonte no print.</p>') + '</section>';
    }
    g.guides.forEach(function (b) {
      var t = FU.guideTotals(b), note = { plan: { in: b.in, out: b.out }, partial: !t.known };
      h += '<section class="gp"><h3 class="small"><strong>Contra ' + esc(b.opp) + '</strong>' + (d.mu && Object.prototype.hasOwnProperty.call(d.mu, guideKey(d, b.opp)) ? ' · substitui o guia salvo' : '') + '</h3>' +
        (d.format === 'Premodern' && archOf(d) && FU.sideNote(archOf(d), b.opp) ? '<p class="small">' + chip('mid', 'Já existe um guia conferido para este confronto') + ' O seu fica guardado em “Seus guias importados”, e o conferido continua na linha do confronto.</p>' : '') +
        ((b.in.length || b.out.length) ? planHtml(d, note, lookup) : '') +
        (t.known && !t.balanced ? '<p class="small">' + chip('mid', 'Entram ' + t.in + ' e saem ' + t.out + ': não bate. Confira o print.') + '</p>' : '') +
        (b.notes.length ? '<ul class="plist">' + b.notes.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') +
        (b.unreadable.length ? '<p class="small">' + chip('mid', b.unreadable.length + (b.unreadable.length === 1 ? ' linha ilegível' : ' linhas ilegíveis')) + ' A IA não conseguiu ler. Confira no print.</p>' : '') +
        (b.src ? '<p class="xs muted">Fonte: ' + esc(b.src) + '</p>' : '<p class="xs muted">Sem fonte no print.</p>') + '</section>';
    });
    if (g.skipped) h += '<p class="small">' + chip('mid', g.skipped + (g.skipped === 1 ? ' guia por adversário' : ' guias por adversário') + ' não entrou') + ' Esses guias só aparecem em decks Premodern.</p>';
    if (g.dupes) h += '<p class="xs muted">' + g.dupes + (g.dupes === 1 ? ' confronto repetido' : ' confrontos repetidos') + ' na resposta: valeu o último de cada.</p>';
    if (g.cut) h += '<p class="small">' + chip('mid', g.cut + ' confrontos além dos 30 primeiros não entraram') + '</p>';
    if (g.ignored) h += '<p class="xs muted">Ignorei ' + g.ignored + (g.ignored === 1 ? ' linha' : ' linhas') + ' fora do formato (texto solto da IA).</p>';
    return h + ((g.primer || g.guides.length) ? '<button type="button" class="btn primary full" data-gsave style="margin-top:12px">Salvar no deck</button>' : '') +
      '<button type="button" class="btn full" data-gback style="margin-top:8px">Voltar e corrigir</button>';
  }
  function guideKey(d, opp) { var k = FU.noAcc(opp), ex = Object.keys(d.mu || {}).filter(function (x) { return FU.noAcc(x) === k; })[0]; return ex || clip(opp, 60); }
  function clip(x, n) { x = String(x || '').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; }
  function guideSave(d, g) {
    var now = Date.now();
    if (g.primer && g.primer.notes.length) d.primer = { lines: g.primer.notes.slice(0, 60).map(function (x) { return clip(x, 400); }), src: clip(g.primer.src, 200), at: now };
    g.guides.forEach(function (b) {
      var t = FU.guideTotals(b), has = b.in.length || b.out.length, cp = function (a) { return a.slice(0, 40).map(function (x) { return { q: x.q, name: clip(x.name, 80) }; }); };
      d.mu = d.mu || {};
      d.mu[guideKey(d, b.opp)] = { plan: has ? { in: cp(b.in), out: cp(b.out) } : null, lines: b.notes.slice(0, 20).map(function (x) { return clip(x, 400); }), src: b.src ? [{ label: clip(b.src, 200) }] : [], partial: has ? !t.known : false, unreadable: b.unreadable.length, at: now };
    });
  }
  function userGuideCard(d) {
    var keys = d.format === 'Premodern' ? Object.keys(d.mu || {}).filter(function (o) { return !muShown[FU.noAcc(o)]; }) : [];
    if (!keys.length) return '';
    var arch = archOf(d) || 'Seu guia';
    var h = '<section class="card pad stack mu" aria-labelledby="ugH" style="margin:16px"><h2 id="ugH" tabindex="-1" style="font-size:1.0625rem">Seus guias importados</h2>';
    keys.forEach(function (o) {
      var id = 'u|' + d.id + '|' + o, open = !!muOpen[id], u = d.mu[o], partial = !!u.partial;
      h += '<button type="button" class="mu-row" data-mu="' + esc(id) + '" aria-expanded="' + open + '"><span class="o">' + esc(o) + '</span><span class="w">Guia</span>' +
        '<span class="s">importado de um print' + (partial ? ' · sem todas as quantidades' : '') + ' · toque para ver o plano de sideboard</span></button>' + (open ? matchupPanel(d, arch, { o: o, wr: null, n: null }, null, true) : '');
    });
    return h + '</section>';
  }
  function matchupCard(d) { muShown = {}; return matchupBase(d) + userGuideCard(d); }
  function matchupBase(d) {
    if (d.format !== 'Premodern') return '';
    var arch = archOf(d), auto = FU.suggestArch(d.name);
    var h = '<section class="card pad stack mu" aria-labelledby="muH" style="margin:16px"><h2 id="muH" style="font-size:1.0625rem">Confrontos do deck</h2>' +
      '<details class="small"' + (arch ? '' : ' open') + '><summary style="min-height:44px;display:flex;align-items:center;cursor:pointer"><span>' + (arch ? 'Reconheci como <strong>' + esc(arch) + '</strong> · trocar' : '<strong>Não reconheci o arquétipo</strong> · escolha') + '</span></summary>' +
      '<label for="muArch" class="visually-hidden">Arquétipo do deck</label>' +
      '<select id="muArch" class="field" data-arch="' + esc(d.id) + '" style="margin-top:4px"><option value="">' + (auto ? 'Automático (' + esc(auto) + ')' : 'Escolher…') + '</option>' +
      FU.META_ARCHS.map(function (a) { return '<option' + (d.arch === a ? ' selected' : '') + '>' + esc(a) + '</option>'; }).join('') + '</select></details>';
    var e = arch ? FU.metaEntry(state.meta, arch) : null;
    if (!arch) return h + '</section>';
    if (!e) {
      var only = guideRows(d, arch, {}, 'Guias de sideboard conferidos');
      return h + (only ? '<p class="small">Ainda sem winrates para <strong>' + esc(arch) + '</strong>, mas já há guias conferidos por confronto:</p>' + only : '<p class="small">Ainda sem winrates para <strong>' + esc(arch) + '</strong>.</p>') + '<a class="btn' + (only ? '' : ' primary') + ' full" href="#/meta">Importar winrates</a></section>';
    }
    var age = FU.metaAgeDays(e.date), sp = FU.metaSplit(e.rows), asc = !state.ui.muBest;
    sp.ok.forEach(function (r) { if (!FU.sideNote(arch, r.o)) muShown[FU.noAcc(r.o)] = true; });
    h += '<p class="small" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">Dados de <strong>' + esc(metaDateText(e.date)) + '</strong> · ' + esc(e.source || 'MTG Decks') +
      (age != null && age > FU.META_STALE_DAYS ? '<span class="seal warn">' + ICO_WARN + 'Desatualizado (' + age + ' dias)</span>' : '') + '</p>';
    if (!sp.ok.length) {
      h += '<p class="small"><strong>Poucos dados:</strong> nenhum confronto com ' + FU.META_MIN + ' partidas ou mais.</p>';
    } else {
      var list = asc ? sp.ok : sp.ok.slice().reverse();
      h += '<button type="button" class="btn full" data-musort aria-label="Inverter a ordem. Agora: ' + (asc ? 'piores primeiro' : 'melhores primeiro') + '">' + svg('<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>') + (asc ? 'Piores primeiro · toque para inverter' : 'Melhores primeiro · toque para inverter') + '</button>' +
        (sp.bad.length ? '' : '<p class="small">Nenhum confronto abaixo de 50% com ' + FU.META_MIN + '+ partidas.</p>');
      list.forEach(function (r) {
        var id = d.id + '|' + r.o, open = !!muOpen[id];
        h += '<button type="button" class="mu-row" data-mu="' + esc(id) + '" aria-expanded="' + open + '"><span class="o">' + esc(r.o) + '</span><span class="w">' + r.wr + '%</span>' +
          '<span class="s">' + (r.wr < 50 ? 'confronto ruim · ' : '') + r.n + ' partidas' + (r.n < FU.META_SMALL ? ' · amostra pequena' : '') + ' · toque para ver o que fazer</span></button>' + (open ? matchupPanel(d, arch, r, e.date) : '');
      });
    }
    if (sp.few.length) h += '<details class="small"><summary style="min-height:44px;display:flex;align-items:center;cursor:pointer">' + sp.few.length + (sp.few.length === 1 ? ' confronto' : ' confrontos') + ' com poucos dados (menos de ' + FU.META_MIN + ' partidas)</summary><ul style="padding-left:20px">' +
      sp.few.map(function (r) { return '<li>' + esc(r.o) + ': ' + r.wr + '% em ' + r.n + ' partidas</li>'; }).join('') + '</ul></details>';
    var shown = {}, fewN = {}; sp.ok.forEach(function (r) { shown[r.o] = true; }); sp.few.forEach(function (r) { fewN[r.o] = r.n; });
    return h + guideRows(d, arch, shown, 'Outros guias conferidos', fewN) + '<a class="btn full" href="#/meta">Importar winrates</a></section>';
  }

  /* ---------- roteamento ---------- */
  function route() {
    var raw = (location.hash || '#/falta').replace(/^#\//, ''), qi = raw.indexOf('?');
    var parts = (qi === -1 ? raw : raw.slice(0, qi)).split('/');
    return { name: parts[0] || 'falta', id: parts[1], query: qi === -1 ? '' : raw.slice(qi + 1) };
  }
  function render() {
    var r = route();
    var tab = ({ troca: 'colecao', precos: 'mais', meta: 'mais', deck: 'decks', novo: 'decks', editar: 'decks', fonte: 'decks', foto: r.id === 'colecao' ? 'colecao' : 'decks' })[r.name] || r.name;
    document.body.classList.toggle('home', ['decks', 'deck', 'novo', 'editar', 'mais', 'fonte', 'colecao', 'foto', 'precos', 'troca', 'meta'].indexOf(r.name) === -1);
    document.querySelectorAll('nav.tabs a').forEach(function (a) {
      if (a.getAttribute('data-tab') === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var mais = document.querySelector('nav.tabs a[data-tab="mais"]');
    var pip = mais.querySelector('.pip');
    if (needsBackup() && !pip) mais.insertAdjacentHTML('beforeend', '<span class="pip"></span><span class="visually-hidden"> (backup pendente)</span>');
    if (!needsBackup() && pip) { pip.nextElementSibling.remove(); pip.remove(); }
    var titles = { falta: 'O que me falta', decks: 'Decks', mais: 'Mais', novo: 'Adicionar deck', editar: 'Editar deck', fonte: 'Adicionar fonte', colecao: 'Coleção', foto: 'Importar por foto', precos: 'Preços da Liga', troca: 'Modo troca', meta: 'Importar winrates' };
    var d = r.name === 'deck' ? deckById(r.id) : null;
    document.title = (d ? d.name : (titles[r.name] || 'O que me falta')) + ' · Playset';
    if (r.name === 'decks') main.innerHTML = viewDecks();
    else if (r.name === 'deck') main.innerHTML = viewDeck(r.id);
    else if (r.name === 'novo') main.innerHTML = viewForm(null, r.id === 'lista');
    else if (r.name === 'editar') main.innerHTML = viewForm(r.id);
    else if (r.name === 'mais') main.innerHTML = viewMais();
    else if (r.name === 'fonte') main.innerHTML = viewFonte(r.id);
    else if (r.name === 'colecao') main.innerHTML = viewColecao();
    else if (r.name === 'foto') main.innerHTML = viewFoto(r.id);
    else if (r.name === 'precos') main.innerHTML = viewPrecos();
    else if (r.name === 'troca') main.innerHTML = viewTroca();
    else if (r.name === 'meta') main.innerHTML = viewMeta();
    else main.innerHTML = viewFalta();
    heroStart();
  }
  var lastRoute = null;
  /* Voltar de verdade: conta quantas telas o app já abriu nesta sessão. Com 1 ou mais, o botão Voltar volta ao histórico (a tela em que a pessoa estava); com 0, vai para a tela-mãe do link. */
  var navDepth = 0, curPrev = '', replacing = false;
  /* Depois de salvar/excluir: se a tela anterior já é o destino, volta para ela (evita duas entradas iguais no histórico); senão troca a entrada atual. */
  function goReplace(h) {
    if (navDepth > 0 && curPrev === h) { history.back(); return; }
    replacing = true; setTimeout(function () { replacing = false; }, 400); location.replace(h);
  }
  function stampNav() { try { history.replaceState({ fu: navDepth, prev: curPrev }, '', location.href); } catch (e2) {} }
  function trackNav() {
    var st = null; try { st = history.state; } catch (e) {}
    var wasReplace = replacing; replacing = false;
    if (st && typeof st.fu === 'number') { navDepth = st.fu; curPrev = st.prev || ''; }
    else {
      if (lastRoute === null) { navDepth = 0; curPrev = ''; }
      else if (!wasReplace) { navDepth += 1; curPrev = lastRoute; }
      stampNav();
    }
  }
  function onRoute() {
    var key = location.hash;
    trackNav();
    render();
    if (key !== lastRoute) { poolOpen = ''; window.scrollTo(0, 0); main.focus({ preventScroll: true }); }
    lastRoute = key;
  }
  window.addEventListener('hashchange', onRoute);

  /* ---------- ações ---------- */
  function newId() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function addDeck(name, format, text) {
    var parsed = FU.parseList(text);
    var d = { id: newId(), name: name, format: format, cards: parsed.cards, createdAt: Date.now() };
    state.decks.push(d);
    persist(true);
    return { deck: d, skipped: parsed.skipped };
  }
  function keepFocusSafe(v) { return String(v).replace(/["\\]/g, '\\$&'); }
  function keepFocus(sel) { var el = main.querySelector(sel); if (el) el.focus({ preventScroll: true }); }

  main.addEventListener('input', function (e) {
    if (e.target.id === 'trIn') { trQuery = e.target.value; var o = document.getElementById('trOut'); if (o) o.innerHTML = trocaOut(); return; }
    if (e.target.id === 'acIn') { clearTimeout(acTimer); var v = e.target.value; acTimer = setTimeout(function () { acSearch(v); }, 250); return; }
    if (e.target.id !== 'st' || route().name !== 'fonte') return;
    var h = document.getElementById('srcHint');
    if (h) h.innerHTML = srcHint(e.target.value);
  });

  main.addEventListener('change', function (e) {
    if (e.target.hasAttribute('data-arch')) {
      var ad = deckById(e.target.getAttribute('data-arch'));
      if (ad) { if (e.target.value) ad.arch = e.target.value; else delete ad.arch; persist(true); render(); keepFocus('#muArch'); }
      return;
    }
    if (e.target.id === 'ptarget') { readPhotoInputs(); render(); keepFocus('#ptarget'); return; }
    if (e.target.hasAttribute('data-sortsel')) { state.ui.sort = e.target.value; persist(false); render(); keepFocus('#fSort'); return; }
    if (!e.target.hasAttribute('data-filter')) return;
    state.ui.deck = e.target.value; persist(false); render(); keepFocus('#fDeck');
  });

  main.addEventListener('keydown', function (e) {
    if (e.target.id === 'trIn' && e.key === 'Enter') { e.preventDefault(); var g = document.querySelector('#trOut a.go'); if (g) g.click(); return; }
    if (e.target.id !== 'acIn' || e.key !== 'Enter') return;
    e.preventDefault();
    var first = document.querySelector('#acList [data-acadd]');
    if (first) acAdd(first.getAttribute('data-acadd'));
  });

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-dropdraft]')) draft = null;
    if (e.target.closest('[data-dropphoto]')) photo = null;
    if (e.target.closest('[data-droplp]')) lp = null;
    if (e.target.closest('[data-dropmeta]')) metaUi = null;
    var gb = e.target.closest('a[data-goback]');
    if (gb && navDepth > 0 && !e.defaultPrevented && !e.metaKey && !e.ctrlKey) { e.preventDefault(); history.back(); return; }
    var aca = e.target.closest('[data-acadd]');
    if (aca && main.contains(aca)) { acAdd(aca.getAttribute('data-acadd')); return; }
    if (e.target.closest('[data-acgo]')) { acGo(); return; }
    var t = e.target.closest('button,[data-act]');
    if (!t || !(main.contains(t) || barAction.contains(t) || fab.contains(t))) return;
    if (t.hasAttribute('data-buy')) {
      var bc = t.getAttribute('data-buy');
      var bscope = bc === 'falta' ? (scopeDecks()) : [deckById(bc)];
      copyText(FU.toLigaMagic(missingAgg(bscope)), 'Copiado. Cole no "Comprar por lista" da Liga Magic.');
      return;
    }
    if (t.hasAttribute('data-consall')) { openSheet('consall', t.getAttribute('data-consall'), t); return; }
    if (t.hasAttribute('data-consmenu')) { openSheet('consact', t.getAttribute('data-consmenu'), t); return; }
    if (t.hasAttribute('data-conspool')) {
      var pv = t.getAttribute('data-conspool').split('|'), pd = deckById(pv[0]), pn = pv.slice(1).join('|');
      var pc = pd && FU.considerPool(pd, canonical).filter(function (x) { return FU.key(x.name) === FU.key(pn); })[0];
      if (pc) {
        var pe = FU.considerAdd(pd, pc.name, pc.qty, pc.board, canonical); pe.auto = 1; pe.cnt = pc.count; pe.tot = pc.total;
        poolOpen = pd.id; persist(true); var yp = window.scrollY; render(); window.scrollTo(0, yp);
        toast('Em consideração: ' + pc.name + '.');
        var pi = cardInfo(pc.name); if (!pi || !pi.typeLine) refreshPrices({ only: [pc.name], silent: true });
      }
      return;
    }
    if (t.hasAttribute('data-conshave')) {
      var hv = t.getAttribute('data-conshave').split('|'), hd = deckById(hv[0]), he = consEntry(hd, +hv[1], hv.slice(2).join('|'));
      if (he) {
        var hh = Math.min(he.qty, spareQty(he.name));
        if (hh >= he.qty) takeSpareEds(he.name, hh); else putSpare(he.name, he.qty - hh, []);
        persist(true); var yh = window.scrollY; render(); window.scrollTo(0, yh);
        keepFocus('[data-conshave^="' + keepFocusSafe(hv[0]) + '|' + hv[1] + '|"]');
        toast(hh >= he.qty ? 'Desmarquei ' + he.name + '.' : 'Marquei que você tem ' + he.name + '.');
      }
      return;
    }
    if (t.hasAttribute('data-guide')) { guideText = ''; guideMu = null; openSheet('guide', t.getAttribute('data-guide'), t); return; }
    if (t.hasAttribute('data-primerdel')) {
      var pdk = deckById(t.getAttribute('data-primerdel'));
      if (pdk && confirm('Remover o "Como jogar" deste deck? Os guias por adversário não mudam.')) { delete pdk.primer; persist(true); render(); toast('Removido.'); }
      return;
    }
    if (t.hasAttribute('data-gdelmu')) {
      var gv = t.getAttribute('data-gdelmu').split('|'), gdd = deckById(gv[0]), go = gv.slice(1).join('|');
      if (gdd && gdd.mu && gdd.mu[go] && confirm('Remover o guia contra ' + go + '? Os guias conferidos do app não mudam.')) {
        delete gdd.mu[go]; if (!Object.keys(gdd.mu).length) delete gdd.mu; delete muOpen['u|' + gdd.id + '|' + go];
        persist(true); render(); toast('Guia removido.');
      }
      return;
    }
    if (t.hasAttribute('data-sheet')) { openSheet(t.getAttribute('data-sheet'), t.getAttribute('data-ctx'), t); return; }
    if (t.hasAttribute('data-collapse')) {
      var ck = t.getAttribute('data-collapse');
      state.ui.collapsed = state.ui.collapsed || {};
      state.ui.collapsed[ck] = !state.ui.collapsed[ck];
      persist(false); var yy = window.scrollY; render(); window.scrollTo(0, yy);
      keepFocus('[data-collapse="' + (window.CSS && CSS.escape ? CSS.escape(ck) : ck) + '"]'); return;
    }
    if (t.hasAttribute('data-clearmiss')) { state.ui.onlyMiss = false; persist(false); render(); return; }
    if (t.hasAttribute('data-dtab')) {
      var did = route().id;
      state.ui.view[did + ':tab'] = t.getAttribute('data-dtab');
      if (state.ui.view[did] === 'research') state.ui.view[did] = 'list';
      persist(false); render(); keepFocus('[data-dtab="' + t.getAttribute('data-dtab') + '"]'); return;
    }
    if (t.hasAttribute('data-fview')) { state.ui.fview = t.getAttribute('data-fview'); persist(false); render(); keepFocus('[data-fview="' + state.ui.fview + '"]'); return; }
    if (t.hasAttribute('data-kind')) { readDraftInputs(); draft.kind = t.getAttribute('data-kind'); draft.err = ''; render(); keepFocus('[data-kind="' + draft.kind + '"]'); return; }
    if (t.hasAttribute('data-rdel')) { readReviewInputs(); draft.rows.splice(+t.getAttribute('data-rdel'), 1); render(); keepFocus('[data-savereview]'); return; }
    if (t.hasAttribute('data-backinput')) { draft.stage = 'input'; draft.rows = null; render(); return; }
    if (t.hasAttribute('data-savereview')) {
      readReviewInputs();
      var rows = draft.rows.filter(function (r) { return r.qty > 0 && r.name; });
      if (!rows.length) { toast('Nenhuma carta para salvar.'); return; }
      saveDraftSource(rows.map(function (r) { return { name: r.name, qty: r.qty, board: r.board, owned: 0 }; }));
      return;
    }
    if (t.hasAttribute('data-delsrc')) {
      var dd = deckById(route().id);
      var src = dd && (dd.sources || []).filter(function (x) { return x.id === t.getAttribute('data-delsrc'); })[0];
      if (src && confirm('Remover a fonte "' + (src.label || 'sem nome') + '"? As cartas que você já colocou no deck continuam lá.')) {
        dd.sources = dd.sources.filter(function (x) { return x !== src; });
        persist(true); render(); toast('Fonte removida.');
      }
      return;
    }
    if (t.hasAttribute('data-onlymiss')) { state.ui.onlyMiss = !state.ui.onlyMiss; persist(false); render(); keepFocus('[data-onlymiss]'); return; }
    if (t.hasAttribute('data-pin')) {
      var pd = deckById(t.getAttribute('data-pin')); if (!pd) return;
      pd.pinned = !pd.pinned; persist(true); render(); keepFocus('[data-pin]');
      toast(pd.pinned ? 'Deck fixado no topo.' : 'Deck desafixado.'); return;
    }
    if (t.hasAttribute('data-musort')) { state.ui.muBest = !state.ui.muBest; persist(false); var ys = window.scrollY; render(); window.scrollTo(0, ys); keepFocus('[data-musort]'); return; }
    if (t.hasAttribute('data-mu')) { var mk = t.getAttribute('data-mu'); muOpen[mk] = !muOpen[mk]; render(); keepFocus('[data-mu="' + keepFocusSafe(mk) + '"]'); return; }
    if (t.hasAttribute('data-muai')) {
      var mv = t.getAttribute('data-muai').split('|'), md = deckById(mv[0]);
      var ma = md ? archOf(md) : '', me = ma ? FU.metaEntry(state.meta, ma) : null;
      var mr = me && me.rows.filter(function (r) { return r.o === mv.slice(1).join('|'); })[0];
      if (!mr && md && ma) mr = { o: mv.slice(1).join('|'), wr: null, n: null };
      if (!mr) return;
      guideText = ''; guideMu = { arch: ma, r: mr, date: me ? me.date : null };
      openSheet('guide', md.id, t);
      return;
    }
    if (t.hasAttribute('data-mfetch')) { metaFetch(false); return; }
    if (t.hasAttribute('data-mcopy')) { copyText(metaPrompt(), 'Pedido copiado. Cole na sua IA.'); return; }
    if (t.hasAttribute('data-mai')) { var mai = AIS.filter(function (a) { return a[0] === t.getAttribute('data-mai'); })[0]; openAi(mai, metaPrompt(), 'Pedido copiado. Se a IA abrir vazia, é só colar.'); return; }
    if (t.hasAttribute('data-mread')) { metaRead(); return; }
    if (t.hasAttribute('data-mback')) { metaUi.parsed = null; render(); keepFocus('#mtext'); return; }
    if (t.hasAttribute('data-msave')) { metaSave(); return; }
    if (t.hasAttribute('data-mclear')) { if (confirm('Apagar os dados de confronto salvos? Os decks não mudam.')) { delete state.meta; persist(true); render(); toast('Dados apagados.'); } return; }
    if (t.hasAttribute('data-photo')) { location.hash = '#/foto/' + t.getAttribute('data-photo'); return; }
    if (t.hasAttribute('data-ctab')) { state.ui.colTab = t.getAttribute('data-ctab'); persist(false); render(); keepFocus('[data-ctab="' + state.ui.colTab + '"]'); return; }
    if (t.hasAttribute('data-fcopy')) { copyText(listPrintPrompt(), 'Pedido copiado. Cole na sua IA e anexe o print.'); return; }
    if (t.hasAttribute('data-pcopy')) { copyText(photoPrompt(), 'Pedido copiado. Cole na sua IA e mande a foto.'); return; }
    if (t.hasAttribute('data-pai')) {
      var ai = AIS.filter(function (a) { return a[0] === t.getAttribute('data-pai'); })[0];
      readPhotoInputs();
      copyText(photoPrompt(), 'Pedido copiado. Se a IA abrir vazia, é só colar.');
      window.open(ai[2] + (ai[0] === 'gemini' ? '' : encodeURIComponent(photoPrompt())), '_blank', 'noopener');
      return;
    }
    if (t.hasAttribute('data-lcopy')) { copyText(precosPrompt(), 'Pedido copiado. Cole na sua IA e mande os prints.'); return; }
    if (t.hasAttribute('data-lai')) {
      var lai = AIS.filter(function (a) { return a[0] === t.getAttribute('data-lai'); })[0];
      readLpInputs();
      copyText(precosPrompt(), 'Pedido copiado. Se a IA abrir vazia, é só colar.');
      window.open(lai[2] + (lai[0] === 'gemini' ? '' : encodeURIComponent(precosPrompt())), '_blank', 'noopener');
      return;
    }
    if (t.hasAttribute('data-lnames')) { copyText(ligaCoverage().miss.join('\n'), 'Nomes copiados.'); return; }
    if (t.hasAttribute('data-lread')) { precosRead(); return; }
    if (t.hasAttribute('data-lback')) { readLpReview(); lp.step = 'input'; lp.rows = null; render(); return; }
    if (t.hasAttribute('data-ldel')) { readLpReview(); lp.rows.splice(+t.getAttribute('data-ldel'), 1); render(); keepFocus('[data-lsave]'); return; }
    if (t.hasAttribute('data-lsave')) { precosSave(); return; }
    if (t.hasAttribute('data-pread')) { photoRead(); return; }
    if (t.hasAttribute('data-pback')) { readPhotoReview(); photo.step = 'input'; photo.rows = null; render(); return; }
    if (t.hasAttribute('data-pdel')) { readPhotoReview(); photo.rows.splice(+t.getAttribute('data-pdel'), 1); render(); keepFocus('[data-psave]'); return; }
    if (t.hasAttribute('data-psave')) { photoSave(); return; }
    if (t.hasAttribute('data-card')) { openCard(t.getAttribute('data-card'), t); return; }
    if (t.hasAttribute('data-sort')) { state.ui.sort = t.getAttribute('data-sort'); persist(false); render(); keepFocus('[data-sort="' + state.ui.sort + '"]'); return; }
    if (t.hasAttribute('data-view')) { state.ui.view[route().id] = t.getAttribute('data-view'); persist(false); render(); keepFocus('[data-view="' + t.getAttribute('data-view') + '"]'); return; }
    if (t.hasAttribute('data-own')) {
      var d = deckById(route().id);
      var c = d && d.cards[+t.getAttribute('data-i')];
      if (!c) return;
      c.owned = c.owned >= c.qty ? 0 : c.qty;
      if (!c.owned) c.eds = [];
      persist(true);
      var i = t.getAttribute('data-i');
      render();
      keepFocus('[data-own][data-i="' + i + '"]');
      return;
    }
    var act = t.getAttribute('data-act');
    var scope = scopeDecks();
    if (act === 'copyLiga') {
      copyText(FU.toLigaMagic(missingAgg(scope)), 'Lista copiada. Cole no "Comprar por lista" da Liga Magic.');
    } else if (act === 'shareMissing') {
      shareText('O que me falta', 'Preciso destas cartas:\n' + FU.toLigaMagic(missingAgg(scope)));
    } else if (act === 'updall') {
      updAll();
    } else if (act === 'refresh') {
      refreshPrices();
    } else if (act === 'copyDeckMissing') {
      copyText(FU.toLigaMagic(missingAgg([deckById(t.getAttribute('data-id'))])), 'O que falta neste deck foi copiado.');
    } else if (act === 'deleteDeck') {
      var id = t.getAttribute('data-id');
      var deck = deckById(id);
      if (deck && confirm('Excluir "' + deck.name + '"? Só dá para recuperar por um backup. As cartas que você marcou como "tenho" ficam guardadas.')) {
        deck.cards.forEach(function (c) { putSpare(c.name, c.owned || 0, c.eds); });
        state.decks = state.decks.filter(function (x) { return x.id !== id; });
        persist(true);
        goReplace('#/decks');
        toast('Excluído.');
      }
    } else if (act === 'example') {
      loadExamples();
    } else if (act === 'backup') {
      sendBackup();
    } else if (act === 'syncon') {
      activateSync((document.getElementById('syKey') || {}).value);
    } else if (act === 'syncrestore') {
      restoreFromCloud();
    } else if (act === 'syncoff') {
      if (confirm('Desativar o backup automático neste celular? Seus decks aqui continuam; a cópia que já está na nuvem fica lá.')) { saveSync({}); setSyncMsg('Desativado neste celular.', true); }
    } else if (act === 'backupcopy') {
      copyBackup(Date.now());
    } else if (act === 'importtext') {
      var bt = document.getElementById('bkText');
      if (!bt || !bt.value.trim()) { setBackupMsg('Cole o texto do backup no campo antes de importar.', 'Cole o texto primeiro.', false); if (bt) bt.focus(); }
      else restoreFromText(bt.value);
    } else if (act === 'snaprestore') {
      restoreSnap();
    } else if (act === 'friend') {
      var txt = document.getElementById('fl').value;
      var out = document.getElementById('friendOut');
      if (!txt.trim()) { out.innerHTML = '<p class="err">Cole a lista do seu amigo primeiro.</p>'; return; }
      var res = FU.matchFriendList(txt, decksWithSpare(), canonical);
      if (!res.length) { out.innerHTML = '<p class="card pad">Você não marcou nenhuma dessas cartas como "tenho".</p>'; return; }
      var reply = 'Tenho estas da sua lista:\n' + res.map(function (r) { return Math.min(r.have, r.wants) + ' ' + r.name; }).join('\n');
      out.innerHTML = '<section class="sec" style="margin:0 -16px"><h3 class="sec-h"><span>Você tem ' + res.length + ' da lista dele</span></h3><ul class="rows">' + res.map(function (r) {
        var info = cardInfo(r.name);
        return '<li class="r"><span class="qty">' + Math.min(r.have, r.wants) + '</span><button class="nm" data-card="' + esc(r.name) + '">' + esc(r.name) +
          '<span class="d">ele quer ' + r.wants + ' · você tem ' + r.have + '</span></button>' + manaHtml(info && info.manaCost) + priceCell(info, 1) + '</li>';
      }).join('') + '</ul></section><button class="btn primary full" data-act="shareReply" style="margin-top:12px">' + ICON.share + 'Responder para ele</button>';
      out.setAttribute('data-reply', reply);
    } else if (act === 'shareReply') {
      shareText('Cartas que eu tenho', document.getElementById('friendOut').getAttribute('data-reply') || '');
    }
  });

  main.addEventListener('submit', function (e) {
    if (e.target.id === 'srcForm') { e.preventDefault(); submitText(); return; }
    if (e.target.id !== 'deckForm') return;
    e.preventDefault();
    var id = e.target.getAttribute('data-id');
    var name = document.getElementById('dn').value.trim();
    var format = document.getElementById('df').value;
    var text = document.getElementById('dl').value;
    var err = document.getElementById('formErr');
    if (!name) { err.textContent = 'Dê um nome.'; document.getElementById('dn').focus(); return; }
    var parsed = FU.parseList(text);
    if (text.trim() && !parsed.cards.length) { err.textContent = 'Não encontrei cartas na lista. Use uma carta por linha, ex.: 4 Counterspell.'; document.getElementById('dl').focus(); return; }
    var deck;
    var markAll = !!(document.getElementById('dm') && document.getElementById('dm').checked) && !!text.trim();
    if (document.getElementById('dm')) state.ui.markAll = document.getElementById('dm').checked;
    if (id) {
      deck = deckById(id);
      deck.name = name; deck.format = format;
      var before = {}, beforeEds = {};
      deck.cards.forEach(function (c) { var k = FU.key(canonical(c.name)); before[k] = (before[k] || 0) + (c.owned || 0); beforeEds[k] = FU.edsMerge(beforeEds[k], FU.edsTake(c.eds, c.owned || 0).taken); });
      deck.cards = FU.mergeOwned(deck.cards, parsed.cards);
      var after = {};
      deck.cards.forEach(function (c) { var k = FU.key(canonical(c.name)); after[k] = (after[k] || 0) + (c.owned || 0); });
      Object.keys(before).forEach(function (k) {
        var lost = before[k] - (after[k] || 0);
        if (lost > 0) { var src = deck.cards.filter(function (c) { return FU.key(canonical(c.name)) === k; }); putSpare(src[0] ? src[0].name : (cardInfo(k) || { name: k }).name, lost, FU.edsPop(beforeEds[k], before[k], lost).removed); }
      });
      deck.cards.forEach(function (c) { if ((c.owned || 0) < c.qty) { var tk2 = takeSpareEds(c.name, c.qty - (c.owned || 0)); c.owned = (c.owned || 0) + tk2.n; c.eds = FU.edsMerge(c.eds, tk2.eds); } });
      if (markAll) FU.markAllOwned(deck.cards);
      persist(true);
    } else {
      deck = addDeck(name, format, text).deck;
      if (!deck.cards.length && format !== 'Lista') state.ui.view[deck.id + ':tab'] = 'deck';
      deck.cards.forEach(function (c) { var tk3 = takeSpareEds(c.name, c.qty); c.owned = tk3.n; c.eds = tk3.eds; });
      if (markAll) FU.markAllOwned(deck.cards);
      persist(true);
    }
    goReplace('#/deck/' + deck.id);
    toast((format === 'Lista' ? (id ? 'Lista atualizada.' : 'Lista salva.') : (id ? 'Deck atualizado.' : 'Deck salvo.')) + (parsed.skipped.length ? ' Ignorei ' + parsed.skipped.length + ' linha(s) que não eram cartas.' : ''));
    var fresh = deck.cards.map(function (c) { return c.name; }).filter(function (n) { var i = cardInfo(n); return !i || !i.typeLine; });
    if (fresh.length) refreshPrices({ only: fresh, silent: true });
  });

  /* ---------- backup e importação ---------- */
  var backupMsg = '';
  /* Mostra o resultado na própria tela (fica até a próxima ação) e num aviso curto. */
  function setBackupMsg(longMsg, shortToast, rerender) {
    backupMsg = longMsg;
    if (rerender && route().name === 'mais') { var y = window.scrollY; render(); window.scrollTo(0, y); }
    else { var el = document.getElementById('bkStatus'); if (el) el.innerHTML = '<strong>' + esc(longMsg) + '</strong>'; }
    toast(shortToast || longMsg);
  }

  /* ---------- backup automático na nuvem (só com a chave do Érick; sem chave, nada sai do celular) ---------- */
  var syncMsg = '', syncTimer = null, syncBusy = false;
  function loadSync() { try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch (e) { return {}; } }
  function saveSync(o) { try { localStorage.setItem(SYNC_KEY, JSON.stringify(o)); } catch (e) {} }
  function hhmm(ts) { var d = new Date(ts), p = function (n) { return (n < 10 ? '0' : '') + n; }; return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' às ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  function setSyncMsg(msg, rerender) {
    syncMsg = msg;
    if (rerender && route().name === 'mais') { var y = window.scrollY; render(); window.scrollTo(0, y); }
    else { var el = document.getElementById('syStatus'); if (el) el.innerHTML = '<strong>' + esc(msg) + '</strong>'; }
  }
  function syncFetch(method, key, body) {
    var opts = { method: method, headers: { Authorization: 'Bearer ' + key } };
    if (body != null) { opts.body = body; opts.headers['Content-Type'] = 'application/json'; }
    return fetch(SYNC_URL, opts);
  }
  function scheduleSync() {
    if (!loadSync().key) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { pushSync(false); }, 4000);
  }
  function pushSync(manual) {
    var sy = loadSync();
    if (!sy.key || syncBusy) return Promise.resolve();
    if (!state.decks.length) { if (manual) setSyncMsg('Não há decks para salvar.', true); return Promise.resolve(); }
    if (!navigator.onLine) { if (manual) setSyncMsg('Sem internet agora. Salvo sozinho quando voltar.', true); return Promise.resolve(); }
    syncBusy = true;
    var sentAt = state.changedAt || 0;
    return syncFetch('PUT', sy.key, backupJson(Date.now())).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        syncBusy = false;
        if (r.ok) {
          sy = loadSync(); sy.at = j.savedAt || Date.now(); sy.pushed = sentAt; sy.err = null; saveSync(sy);
          state.lastBackup = sy.at; persist(false);
          setSyncMsg('Salvo na nuvem em ' + hhmm(sy.at) + '.', manual);
          if (manual) toast('Backup salvo na nuvem.');
        } else if (r.status === 401) {
          setSyncMsg('A chave não foi aceita. Confira a chave e ative de novo.', true);
        } else {
          setSyncMsg('Não consegui salvar na nuvem agora (' + (j.error || 'erro ' + r.status) + '). Tento de novo na próxima mudança.', manual);
        }
      });
    }).catch(function () {
      syncBusy = false;
      setSyncMsg('Não consegui falar com a nuvem. Tento de novo na próxima mudança.', manual);
    });
  }
  function activateSync(key) {
    key = String(key || '').trim().toLowerCase();
    if (!key) { setSyncMsg('Digite a chave primeiro.', true); return; }
    if (!navigator.onLine) { setSyncMsg('Sem internet agora. Tente de novo com conexão.', true); return; }
    setSyncMsg('Conferindo a chave…', false);
    syncFetch('GET', key).then(function (r) {
      if (r.status === 401) { setSyncMsg('Essa chave não foi aceita. Confira e tente de novo.', true); return; }
      return r.json().catch(function () { return {}; }).then(function (j) {
        saveSync({ key: key });
        if (r.ok && j.data && j.data.state && j.data.state.decks.length) {
          var n = j.data.state.decks.length, when = hhmm(j.savedAt || j.data.savedAt || Date.now());
          if (!state.decks.length || confirm('Já existe um backup na nuvem (' + n + ' deck(s), de ' + when + '). Trazer ele para este celular? OK substitui os decks daqui. Cancelar mantém os daqui e atualiza a nuvem.')) {
            restoreFromText(JSON.stringify(j.data)).then(function (ok) {
              if (ok) setSyncMsg('Ativado. Decks trazidos da nuvem.', true); else pushSync(true);
            });
            return;
          }
        }
        setSyncMsg('Ativado. Vou salvar na nuvem a cada mudança.', true);
        pushSync(true);
      });
    }).catch(function () { setSyncMsg('Não consegui falar com a nuvem. Tente de novo.', true); });
  }
  function restoreFromCloud() {
    var sy = loadSync();
    if (!sy.key) return;
    if (!navigator.onLine) { setSyncMsg('Sem internet agora.', true); return; }
    syncFetch('GET', sy.key).then(function (r) {
      if (r.status === 401) { setSyncMsg('A chave não foi aceita.', true); return; }
      if (r.status === 404) { setSyncMsg('Ainda não há backup na nuvem.', true); return; }
      return r.json().then(function (j) { return restoreFromText(JSON.stringify(j.data)); }).then(function (ok) { if (ok) setSyncMsg('Decks trazidos da nuvem.', true); });
    }).catch(function () { setSyncMsg('Não consegui falar com a nuvem.', true); });
  }
  function syncSectionHtml() {
    var sy = loadSync();
    var h = '<section class="card pad stack" aria-labelledby="sy"><h3 id="sy" style="font-size:1.0625rem">Backup automático</h3>';
    if (sy.key) {
      h += '<p class="small">Ativo. Cada mudança nos decks é salva na nuvem sozinha, sem você fazer nada.</p>' +
        '<p class="small" id="syStatus" role="status" aria-live="polite"><strong>' + esc(syncMsg || (sy.at ? 'Último salvamento: ' + hhmm(sy.at) + '.' : 'Ainda não salvou.')) + '</strong></p>' +
        '<button class="btn full" data-act="syncrestore">Voltar da nuvem</button>' +
        '<button class="btn full" data-act="syncoff">Desativar neste celular</button>';
    } else {
      h += '<p class="muted small">Salva seus decks na nuvem a cada mudança. Precisa de uma chave. Sem chave, use o backup manual abaixo.</p>' +
        '<p class="small" id="syStatus" role="status" aria-live="polite">' + (syncMsg ? '<strong>' + esc(syncMsg) + '</strong>' : '') + '</p>' +
        '<label for="syKey" class="small">Chave do backup</label>' +
        '<input id="syKey" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="xxxx-xxxx-xxxx">' +
        '<button class="btn primary full" data-act="syncon">Ativar</button>';
    }
    return h + '</section>';
  }

  /* O backup leva os decks e tudo o que você marcou. Os dados das cartas (preços, imagens) baixam de novo com internet. */
  function backupJson(now) {
    return JSON.stringify({ app: 'falta-uma', version: 2, savedAt: now, state: state, pr: db.pr || {} });
  }
  function markBackup(now) { state.lastBackup = now; persist(false); }

  /* O backup viaja como texto (mensagem de WhatsApp, Telegram, nota). Comprimido, para caber e para não virar um paredão. */
  function b64FromBytes(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function bytesFromB64(b64) {
    var s = atob(b64), u = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  function gzipToB64(str) {
    if (!window.CompressionStream || !window.Response) return Promise.resolve(null);
    try {
      var cs = new CompressionStream('gzip');
      var wr = cs.writable.getWriter();
      wr.write(new TextEncoder().encode(str)).catch(function () {});
      wr.close().catch(function () {});
      return new Response(cs.readable).arrayBuffer().then(function (buf) { return b64FromBytes(new Uint8Array(buf)); }).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }
  function gunzipFromB64(b64) {
    if (!window.DecompressionStream || !window.Response) return Promise.reject(new Error('sem suporte'));
    var ds = new DecompressionStream('gzip');
    var wr = ds.writable.getWriter();
    wr.write(bytesFromB64(b64)).catch(function () {});
    wr.close().catch(function () {});
    return new Response(ds.readable).text();
  }
  var BACKUP_MAX_CHARS = 60000; // abaixo do limite de uma mensagem do WhatsApp
  /* Monta a mensagem do backup: cabeçalho legível + código (ou o JSON puro, se o aparelho não comprime). */
  function backupMessage(now) {
    var json = backupJson(now);
    return gzipToB64(json).then(function (code) {
      var head = 'Backup do Playset de ' + fmtDate(now) + '\nGuarde isto. Para voltar: segure este arquivo no WhatsApp, toque em Compartilhar e escolha Playset.\n\n';
      return head + (code ? 'PLAYSET1:' + code + ':FIM' : json);
    });
  }

  function copyBackup(now) {
    backupMessage(now).then(function (msg) {
      var ok = function () {
        markBackup(now);
        setBackupMsg('Copiei o backup. Cole numa conversa com você mesmo (no WhatsApp, a conversa com o seu próprio número) ou numa nota, e não apague. Para voltar, cole o texto em \"Importar do texto\".', 'Backup copiado.', true);
      };
      var fail = function () { setBackupMsg('Não consegui copiar o backup. Tente de novo em alguns segundos.', 'Não consegui copiar.', false); };
      var legacy = function () {
        var ta = document.createElement('textarea');
        ta.value = msg; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var good = false;
        try { good = document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
        if (good) ok(); else fail();
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(msg).then(ok, legacy);
      else legacy();
    });
  }

  /* Enviar: compartilha o backup como ANEXO (aparece como um cartão de arquivo no WhatsApp, sem paredão de texto).
     Nada é baixado no celular. Se o aparelho recusar o anexo, cai no texto; se recusar tudo, copia. */
  function backupFileName(now) {
    var d = new Date(now), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'Playset-backup-' + p(d.getDate()) + '-' + p(d.getMonth() + 1) + '.txt';
  }
  function sendBackupText(now, msg, why) {
    if (!navigator.share || msg.length > BACKUP_MAX_CHARS) { copyBackup(now); return; }
    var p;
    try { p = navigator.share({ title: 'Backup Playset', text: msg }); }
    catch (e) { copyBackup(now); return; }
    p.then(function () {
      markBackup(now);
      setBackupMsg('Compartilhei o backup como texto' + (why ? ' (o anexo não funcionou: ' + why + ')' : '') + '. Confira se chegou e não apague.', 'Backup compartilhado.', true);
    }).catch(function (err) {
      if (err && err.name === 'AbortError') { setBackupMsg('Você fechou a lista de apps antes de enviar. O backup não foi salvo.', 'Backup não enviado.', false); return; }
      copyBackup(now);
    });
  }
  function sendBackup() {
    var now = Date.now();
    backupMessage(now).then(function (msg) {
      var file = null;
      try { file = new File([msg], backupFileName(now), { type: 'text/plain' }); } catch (e) {}
      var canFile = file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] });
      if (!canFile) { sendBackupText(now, msg, file && navigator.share ? 'este celular não aceita anexo' : ''); return; }
      var note = 'Este é o seu backup do Playset de ' + fmtDate(now) + '. Não apague este arquivo nem esta conversa.\n\n' +
        'Para voltar os decks: segure este arquivo aqui no WhatsApp, toque em Compartilhar e escolha Playset. ' +
        'O app pergunta se quer importar. Não precisa baixar nada.';
      var p;
      try { p = navigator.share({ files: [file], title: 'Backup Playset', text: note }); }
      catch (e) { sendBackupText(now, msg, e && e.name); return; }
      p.then(function () {
        markBackup(now);
        setBackupMsg('Enviei o backup como arquivo. Confira se chegou na conversa e não apague.', 'Backup enviado.', true);
      }).catch(function (err) {
        if (err && err.name === 'AbortError') { setBackupMsg('Você fechou a lista de apps antes de enviar. O backup não foi salvo.', 'Backup não enviado.', false); return; }
        sendBackupText(now, msg, (err && err.name) || 'erro desconhecido');
      });
    });
  }

  /* Lê um backup de qualquer forma que ele chegue: arquivo, mensagem com código, JSON puro ou a mensagem inteira colada.
     O próprio gzip denuncia texto cortado (falha ao descomprimir), então o marcador :FIM não é obrigatório. */
  function decodeBackup(text) {
    text = String(text || '').replace(/^﻿/, '');
    var parse = function (str) { try { var d = JSON.parse(str); return d && typeof d === 'object' ? d : null; } catch (e) { return null; } };
    var at = text.indexOf('PLAYSET1:');
    if (at >= 0) {
      var rest = text.slice(at + 9);
      var fim = rest.indexOf(':FIM');
      var cands = [];
      var clean = function (x) { return x.replace(/[^A-Za-z0-9+\/=]/g, ''); };
      if (fim >= 0) cands.push(clean(rest.slice(0, fim)));
      var first = rest.match(/^\s*([A-Za-z0-9+\/=]+)/);
      if (first) cands.push(first[1]);
      var runs = rest.match(/[A-Za-z0-9+\/=]+(?:[ \t]*\r?\n[ \t]*[A-Za-z0-9+\/=]+)*/);
      if (runs) cands.push(clean(runs[0]));
      var seen = {}, list = cands.filter(function (c) { if (!c || seen[c]) return false; seen[c] = 1; return true; });
      var tryNext = function (i) {
        if (i >= list.length) return Promise.resolve({ cut: true });
        var c = list[i];
        c = c.slice(0, c.length - (c.length % 4)); // base64 só fecha em múltiplos de 4
        return gunzipFromB64(c).then(function (str) {
          var d = parse(str);
          return d ? { data: d } : tryNext(i + 1);
        }).catch(function () { return tryNext(i + 1); });
      };
      return tryNext(0);
    }
    var t = text.trim(), d = parse(t);
    if (!d) { var i = t.indexOf('{'), j = t.lastIndexOf('}'); if (i >= 0 && j > i) d = parse(t.slice(i, j + 1)); }
    return Promise.resolve({ data: d });
  }

  function restoreFromText(text) {
    return decodeBackup(text).then(function (res) {
      if (res.cut) {
        setBackupMsg('Esse texto está incompleto: o WhatsApp cortou o final da mensagem. Use o arquivo .txt do backup (ele não corta), ou faça um backup novo.', 'Texto cortado.', false);
        return false;
      }
      var data = res.data;
      if (!data || data.app !== 'falta-uma' || !data.state || !Array.isArray(data.state.decks)) {
        setBackupMsg('Isso não parece um backup do Playset. Cole a mensagem que o próprio app gerou em \"Enviar backup\".', 'Não é um backup do Playset.', false);
        return false;
      }
      var when = fmtDate(data.savedAt) || 'data desconhecida';
      if (!confirm('Importar ' + data.state.decks.length + ' deck(s) do backup de ' + when + '? Os decks atuais serão substituídos. Antes, guardo uma cópia do que está no app agora.')) return false;
      takeSnap('Antes de importar o backup de ' + when, JSON.stringify(state));
      state = data.state;
      state.ui = state.ui || { sort: 'name', deck: 'all', view: {} };
      if (data.cards) db = data.cards; // backups antigos levavam os dados das cartas
      else if (data.pr) { db.pr = db.pr || {}; Object.keys(data.pr).forEach(function (k) { db.pr[k] = data.pr[k]; }); }
      persist(false); persistDb();
      backupMsg = 'Backup de ' + when + ' importado.';
      goReplace('#/decks');
      render();
      toast('Backup importado.');
      return true;
    });
  }

  function restoreSnap() {
    var sn = readSnap();
    if (!sn) return;
    if (!confirm('Voltar os decks para a cópia de ' + fmtDate(sn.at) + ' (' + sn.reason + ')? O que está no app agora fica guardado antes.')) return;
    var restored;
    try { restored = JSON.parse(sn.raw); } catch (e) { toast('Essa cópia não pôde ser lida.'); return; }
    takeSnap('Antes de voltar à cópia de ' + fmtDate(sn.at), JSON.stringify(state));
    state = restored;
    state.ui = state.ui || { sort: 'name', deck: 'all', view: {} };
    persist(false);
    backupMsg = 'Voltei os decks para a cópia de ' + fmtDate(sn.at) + '.';
    goReplace('#/decks');
    render();
    toast('Cópia restaurada.');
  }

  main.addEventListener('change', function (e) {
    if (e.target.id !== 'restore') return;
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var input = e.target;
    if (f.size > 5 * 1024 * 1024) { setBackupMsg('Esse arquivo é grande demais para ser um backup do Playset.', 'Arquivo grande demais.', false); input.value = ''; return; }
    var reader = new FileReader();
    reader.onload = function () { restoreFromText(reader.result).then(function () { input.value = ''; }); };
    reader.onerror = function () { setBackupMsg('Não consegui abrir esse arquivo.', 'Não consegui abrir o arquivo.', false); input.value = ''; };
    reader.readAsText(f);
  });

  function loadExamples() {
    var ug = addDeck('UG Madness (exemplo)', 'Premodern',
      'Deck\n4 Wild Mongrel\n4 Aquamoeba\n4 Basking Rootwalla\n4 Arrogant Wurm\n2 Wonder\n4 Roar of the Wurm\n4 Circular Logic\n4 Careful Study\n4 Deep Analysis\n4 Yavimaya Coast\n9 Island\n9 Forest\n\nSideboard\n2 Counterspell\n3 Naturalize\n4 Hydroblast\n').deck;
    ug.cards.forEach(function (c) { c.owned = c.name === 'Circular Logic' ? 1 : c.qty; });
    var uw = addDeck('UW Land Still (exemplo)', 'Premodern',
      'Deck\n4 Standstill\n4 Counterspell\n4 Swords to Plowshares\n4 Fact or Fiction\n4 Impulse\n3 Wrath of God\n3 Decree of Justice\n2 Eternal Dragon\n4 Mishra\'s Factory\n4 Adarkar Wastes\n4 Coastal Tower\n9 Island\n4 Plains\n\nSideboard\n3 Disenchant\n3 Hydroblast\n2 Circle of Protection: Red\n').deck;
    uw.cards.forEach(function (c) {
      if (/Counterspell|Impulse|Coastal Tower|Swords/.test(c.name)) c.owned = Math.min(2, c.qty);
      if (/Wrath|Disenchant|Island|Plains/.test(c.name)) c.owned = c.qty;
    });
    uw.sources = [
      { id: newId(), kind: 'text', label: 'Lista de torneio (exemplo)', url: '', createdAt: Date.now(), cards: FU.parseList('4 Standstill\n4 Counterspell\n4 Swords to Plowshares\n4 Fact or Fiction\n3 Wrath of God\n2 Decree of Justice\n2 Exalted Angel\n4 Mishra\'s Factory\n4 Adarkar Wastes\n\nSideboard\n3 Disenchant\n2 Circle of Protection: Red').cards },
      { id: newId(), kind: 'image', label: 'Print do Discord (exemplo)', url: '', createdAt: Date.now(), cards: FU.parseList('4 Standstill\n4 Counterspell\n3 Swords to Plowshares\n3 Fact or Fiction\n4 Impulse\n3 Wrath of God\n2 Eternal Dragon\n4 Mishra\'s Factory\n\nSideboard\n3 Disenchant\n3 Hydroblast').cards },
      { id: newId(), kind: 'link', label: 'Moxfield (exemplo)', url: 'https://moxfield.com/', createdAt: Date.now(), cards: [] }
    ];
    persist(true);
    render();
    toast('Decks de exemplo adicionados. Dá para excluir em Editar.');
    refreshPrices({ silent: true });
  }

  /* ---------- início ---------- */
  document.body.classList.remove('compact'); // altura AAA sempre
  onRoute();
  var needsUpgrade = db.v !== DATA_VERSION && Object.keys(db.cards).length;
  if (navigator.onLine && state.decks.length && (needsUpgrade || !db.updatedAt || Date.now() - db.updatedAt > STALE_MS)) {
    refreshPrices({ silent: true });
  }
  window.addEventListener('online', function () { setStatus(); scheduleSync(); });
  (function () { var sy = loadSync(); if (sy.key && state.decks.length && (state.changedAt || 0) > (sy.pushed || 0)) scheduleSync(); })();
  if ('serviceWorker' in navigator && location.protocol === 'https:' && window.isSecureContext) {
    try { navigator.serviceWorker.register('sw.js').catch(function () {}); } catch (e) {}
  }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}

  /* Arquivo recebido pelo Compartilhar do celular (WhatsApp > arquivo > Compartilhar > Playset): o service worker guardou o texto. */
  if (/[?&]shared=1/.test(location.search) && window.caches) {
    caches.open('fu-share').then(function (c) {
      return c.match('share-inbox').then(function (res) {
        try { history.replaceState({ fu: navDepth, prev: curPrev }, '', location.pathname + '#/mais'); } catch (e) {}
        if (!res) { location.hash = '#/mais'; setBackupMsg('Não recebi nenhum arquivo. Tente compartilhar de novo.', 'Sem arquivo.', true); return; }
        return res.text().then(function (text) {
          return c.delete('share-inbox').then(function () { location.hash = '#/mais'; return restoreFromText(text); });
        });
      });
    }).catch(function () { setBackupMsg('Não consegui ler o arquivo compartilhado.', 'Erro ao ler o arquivo.', true); });
  }
})();
