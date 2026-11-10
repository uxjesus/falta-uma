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
  function persist(changed) { if (changed) state.changedAt = Date.now(); save(STATE_KEY, state); }
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
    } else if (el.classList.contains('thumb') || el.classList.contains('art') || el.classList.contains('cardimg') || el.closest('.gcard')) {
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
    return '<div class="dlg-sec"><h3>Nos seus decks · quantas você tem</h3>' + lines.map(function (l) {
      var bl = l.c.board === 'side' ? ' · side' : (l.c.board === 'commander' ? ' · comandante' : '');
      return '<div class="ownrow"><div><a href="#/deck/' + esc(l.d.id) + '" data-close>' + esc(l.d.name) + '</a><div class="xs muted">' + l.c.qty + ' no deck' + bl +
        (FU.missingOf(l.c) ? ' · <strong style="color:var(--miss)">faltam ' + FU.missingOf(l.c) + '</strong>' : ' · completo') + '</div></div>' +
        '<div class="stepper" role="group" aria-label="Quantas eu tenho em ' + esc(l.d.name) + '">' +
        '<button data-mown="-1" data-d="' + esc(l.d.id) + '" data-i="' + l.i + '" aria-label="Tenho uma a menos"' + (l.c.owned <= 0 ? ' disabled' : '') + '>−</button>' +
        '<output aria-live="polite">' + l.c.owned + '/' + l.c.qty + '</output>' +
        '<button data-mown="1" data-d="' + esc(l.d.id) + '" data-i="' + l.i + '" aria-label="Tenho uma a mais"' + (l.c.owned >= l.c.qty ? ' disabled' : '') + '>+</button></div></div>';
    }).join('') + '</div>';
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
      ? '<p class="big">' + brl.format(note.brl) + '</p><p class="xs muted">Anotado da Liga Magic em ' + esc(fmtDate(note.at)) + '</p>' + (estLine ? '<p class="xs muted" style="margin-top:4px">Referência: ' + estLine + '</p>' : '')
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
      ownHtml(nm) + coverHtml(nm) +
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
    var t = e.target.closest('[data-mown]');
    if (!t) return;
    var d = deckById(t.getAttribute('data-d'));
    var c = d && d.cards[+t.getAttribute('data-i')];
    if (!c) return;
    c.owned = Math.max(0, Math.min(c.qty, c.owned + (+t.getAttribute('data-mown'))));
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
  function priceCell(info, qty) {
    var t = moneyShort(info, qty);
    return t ? '<span class="pr">' + t + '</span>' : '<span class="pr na">' + (info && info.notFound ? 'não achei' : '—') + '</span>';
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

  function viewDecks() {
    fab.innerHTML = '';
    barAction.innerHTML = '<a class="ib" href="#/novo" aria-label="Novo deck">' + ICON.plus + '</a>';
    if (!state.decks.length) {
      return '<div class="card empty stack"><h1 style="font-size:1.5rem">Decks</h1><p class="muted">Nenhum deck ainda.</p>' +
        '<a class="btn primary full" href="#/novo">Adicionar deck</a><button class="btn full" data-act="example">Ver com decks de exemplo</button></div>';
    }
    var html = '<header class="head"><h1>Decks</h1><p class="metaline">' + state.decks.length + (state.decks.length === 1 ? ' deck' : ' decks') + '</p></header>';
    var fl = formats();
    fl.forEach(function (fm) {
    var inF = state.decks.filter(function (d) { return fmtOf(d) === fm; });
    if (fl.length > 1) html += '<h2 class="sec-h fmt-h">' + esc(fm) + ' <span class="c">(' + inF.length + ')</span></h2>';
    html += '<ul class="decklist">';
    inF.forEach(function (d) {
      var p = FU.deckProgress(d);
      var miss = p.need - p.have;
      var f = featured(d);
      var mv = deckValue(d, true);
      html += '<li><a class="dk" href="#/deck/' + esc(d.id) + '"><div class="art" style="' + (f ? '' : phStyle({ colors: deckColors(d) })) + '">' +
        (f ? '<img src="' + esc(artOf(f)) + '" alt="" loading="lazy" decoding="async">' : '') +
        '<span class="badge">' + esc(d.format || 'Sem formato') + '</span>' + pipsHtml(deckColors(d)) + '</div>' +
        '<div class="body"><strong>' + esc(d.name) + '</strong>' +
        '<div class="ln"><span>' + (d.cards.length ? p.pct + '% pronto · ' + (miss ? 'faltam ' + miss : 'completo') : 'Sem cartas · ' + ((d.sources || []).length || 0) + ' fontes na pesquisa') + '</span><span>' + (mv ? '≈ ' + brl0.format(mv) : '') + '</span></div>' +
        '<div class="bar" aria-hidden="true"><span style="width:' + p.pct + '%"></span></div></div></a></li>';
    });
    html += '</ul>';
    });
    return html;
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
      manaHtml(info && info.manaCost) + ownBtn(c, idx) + '</li>';
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
      } else {
        var v = ui.view[ctx] === 'list' ? 'list' : 'grid';
        html += segRow('Ver como', 'dview', [['grid', 'Imagens'], ['list', 'Lista']], v);
        html += segRow('Mostrar', 'onlyMiss', [['no', 'Todas'], ['yes', 'Só o que falta']], ui.onlyMiss ? 'yes' : 'no');
      }
      html += segRow('Ordenar por', 'sort', [['name', 'Nome'], ['price', 'Preço'], ['cmc', 'Custo']], ui.sort);
    } else if (type === 'export') {
      var miss = ctx === 'falta' ? FU.aggregateMissing(scopeDecks(), canonical) : FU.aggregateMissing([deckById(ctx)], canonical);
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
    sheetBody.innerHTML = html;
    if (!sheet.open) sheet.showModal();
  }
  sheetBody.addEventListener('click', function (e) {
    var t = e.target.closest('button');
    if (!t || !sheetCtx) return;
    var ctx = sheetCtx.ctx;
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
    var txt = FU.toLigaMagic(FU.aggregateMissing(scope, canonical));
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
    var order = ['Premodern', 'Commander', 'Pauper', 'Legacy', 'Modern', 'Outro', 'Sem formato'];
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
  function heroHtml() {
    var a = heroArt();
    return '<section class="hero">' + (a ? '<img class="art" src="' + esc(a) + '" alt="" decoding="async">' : '') + '<span class="shade" aria-hidden="true"></span>' +
      '<div class="info"><p class="wordmark"><img src="icons/icon-192.png" alt="" width="40" height="40">Playset</p>' +
      '<p class="tagline">A wantlist dos seus decks</p></div></section>';
  }
  function viewFalta() {
    var ui = state.ui;
    if (ui.deck !== 'all' && !deckById(ui.deck)) ui.deck = 'all';
    var items = FU.aggregateMissing(scopeDecks(), canonical);
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
        '<button class="btn full" data-act="example">Ver com decks de exemplo</button></div>';
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

    if (!items.length) return html + '<div class="card empty"><p><strong>Nada faltando aqui.</strong></p></div>';
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
          return '<li><button class="gc" data-card="' + esc(i.name) + '" aria-label="Faltam ' + i.total + ' ' + esc(i.name) + (pr ? ', ' + pr + ' cada' : '') + '">' +
            (imgOf(info) ? '<img src="' + esc(imgOf(info)) + '" alt="" loading="lazy" decoding="async" width="488" height="680">' : '<span class="ph" style="' + phStyle(info) + '">' + esc(i.name) + '</span>') +
            '<span class="cap" aria-hidden="true"><span class="m">falta ' + i.total + '</span><span>' + (pr || '—') + '</span></span></button></li>';
        }).join('') + '</ul></section>';
        return;
      }
      html += '<ul class="rows">';
      g.items.forEach(function (i) {
        var info = cardInfo(i.name);
        html += '<li class="r"><span class="q miss" aria-label="faltam ' + i.total + '">' + i.total + '</span>' +
          '<button class="nm" data-card="' + esc(i.name) + '">' + esc(i.name) +
          (state.decks.length > 1 && ui.deck === 'all' ? '<span class="d">' + i.decks.map(function (d) { return esc(d.deckName) + (i.decks.length > 1 ? ' ' + d.qty : ''); }).join(' · ') + '</span>' : '') + '</button>' +
          manaHtml(info && info.manaCost) + priceCell(info, i.total) + '</li>';
      });
      html += '</ul></section>';
    });
    return html + '<p class="foot">Terrenos básicos não entram. Preço: o que você anotou da Liga Magic ou a edição mais barata no Scryfall, convertida para real.</p>';
  }

  function viewDeck(id) {
    var d = deckById(id);
    fab.innerHTML = '';
    barAction.innerHTML = '';
    if (!d) return '<div class="card empty stack"><p>Deck não encontrado.</p><a class="btn" href="#/decks">Voltar para Decks</a></div>';
    var p = FU.deckProgress(d);
    var miss = p.need - p.have;
    var f = featured(d);
    var tab = state.ui.view[d.id + ':tab'] === 'research' || state.ui.view[d.id] === 'research' ? 'research' : 'deck';
    var view = state.ui.view[d.id] === 'list' ? 'list' : 'grid';
    var onlyMiss = !!state.ui.onlyMiss;
    var basics = d.cards.filter(function (c) { return FU.isBasic(c.name); });
    var total = d.cards.filter(function (c) { return c.board !== 'side'; }).reduce(function (s, c) { return s + c.qty; }, 0);
    var missV = deckValue(d, true);
    var nSrc = (d.sources || []).length;

    var html = '<section class="banner" style="' + (f ? '' : phStyle({ colors: deckColors(d) })) + '">' +
      (f ? '<img class="art" src="' + esc(artOf(f)) + '" alt="" decoding="async">' : '') + '<span class="shade"></span>' +
      '<div class="info"><a href="#/decks" class="back">' + ICON.back + 'Decks</a>' +
      '<h1>' + esc(d.name) + '</h1>' +
      '<p style="display:flex;gap:8px;align-items:center"><span class="badge">' + esc(d.format || 'Sem formato') + '</span>' + pipsHtml(deckColors(d)) + '</p>' +
      (d.cards.length ? '<p class="metaline"><span><strong>' + p.pct + '%</strong> pronto</span><span>' + total + ' cartas</span>' +
        (miss ? '<span>faltam <strong>' + miss + '</strong>' + (missV ? ' · ≈ ' + brl0.format(missV) : '') + '</span>' : '<span>completo</span>') + '</p>' +
        '<div class="meter" aria-hidden="true"><span style="width:' + p.pct + '%"></span></div>' : '<p class="metaline"><span>Sem cartas ainda. Monte pela Pesquisa.</span></p>') +
      '<p class="updated">Atualizado ' + esc(ago(state.changedAt || d.createdAt) || '') + '</p></div></section>' +
      '<div class="tabsbar" role="tablist" aria-label="Seções do deck">' +
      '<button role="tab" data-dtab="deck" aria-selected="' + (tab === 'deck') + '">Deck</button>' +
      '<button role="tab" data-dtab="research" aria-selected="' + (tab === 'research') + '">Pesquisa' + (nSrc ? ' (' + nSrc + ')' : '') + '</button></div>';

    if (tab === 'research') return html + viewResearch(d);
    if (!d.cards.length) {
      return html + '<div class="card pad stack" style="margin:16px"><p><strong>Seu deck ainda não tem cartas.</strong></p><p class="muted small">Use a Pesquisa para juntar listas de referência e escolher o que entra, ou edite o deck e cole uma lista.</p>' +
        '<button class="btn primary full" data-dtab="research">Abrir Pesquisa</button></div>';
    }
    html += toolsBar([
      toolBtn('data-sheet="export" data-ctx="' + esc(d.id) + '"', ICO.exp, 'Exportar'),
      toolBtn('data-sheet="owned" data-ctx="' + esc(d.id) + '"', svg('<path d="M9 11l3 3 8-8"/><path d="M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11"/>'), 'Marcar o que eu tenho colando uma lista'),
      toolBtn('data-buy="' + esc(d.id) + '"' + (miss ? '' : ' disabled'), svg('<path d="M6 6h15l-1.5 9h-12z"/><path d="M6 6 5 3H2"/><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/>'), 'Comprar: copiar o que falta para a Liga Magic')
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
    if (view === 'list') html += '<p class="foot">Toque no marcador à direita para dizer que tem todas (ou nenhuma). Para ajustar uma por uma, toque no nome da carta.</p>';
    return html;
  }

  function viewForm(id) {
    var d = id ? deckById(id) : null;
    barAction.innerHTML = ''; fab.innerHTML = '';
    if (id && !d) return '<div class="card empty"><p>Deck não encontrado.</p></div>';
    var formats = ['Premodern', 'Commander', 'Pauper', 'Legacy', 'Modern', 'Outro'];
    return '<header class="head"><a href="' + (d ? '#/deck/' + esc(d.id) : '#/decks') + '" class="link" style="margin-left:-4px">' + ICON.back + (d ? 'Voltar ao deck' : 'Decks') + '</a>' +
      '<h1>' + (d ? 'Editar deck' : 'Adicionar deck') + '</h1></header>' +
      '<form id="deckForm" class="form" novalidate data-id="' + (d ? esc(d.id) : '') + '">' +
      '<div><label for="dn">Nome do deck</label><input type="text" id="dn" autocomplete="off" required placeholder="Ex.: UG Madness" value="' + (d ? esc(d.name) : '') + '"></div>' +
      '<div><label for="df">Formato</label><select id="df" class="field">' + formats.map(function (f) { return '<option' + (d && d.format === f ? ' selected' : '') + '>' + f + '</option>'; }).join('') + '</select></div>' +
      '<div><label for="dl">Lista <span class="muted">(opcional: dá para montar pela Pesquisa)</span></label><p class="small muted" id="dlh" style="margin:0 0 8px">Cole do Moxfield, Archidekt, MTG Goldfish, Arena ou WhatsApp. Uma carta por linha, ex.: 4 Counterspell. Sideboard depois de uma linha "Sideboard".' + (d ? ' O que você já marcou como "tenho" continua marcado.' : '') + '</p>' +
      '<textarea id="dl" aria-describedby="dlh" spellcheck="false" autocapitalize="off">' + (d ? esc(FU.toText(d.cards)) : '') + '</textarea></div>' +
      '<p id="formErr" class="err" role="alert"></p>' +
      '<button class="btn primary full" type="submit">' + (d ? 'Salvar alterações' : 'Salvar deck') + '</button>' +
      (d ? '<button class="btn full" type="button" data-act="deleteDeck" data-id="' + esc(d.id) + '" style="color:var(--miss);border-color:var(--miss)">Excluir deck</button>' : '') +
      '</form>';
  }

  function viewMais() {
    barAction.innerHTML = ''; fab.innerHTML = '';
    var nag = needsBackup();
    return '<header class="head"><h1>Mais</h1></header><div class="form">' +
      '<section class="card pad stack" aria-labelledby="pr"><h2 id="pr" style="font-size:1.0625rem">Atualizar preços e cartas</h2>' +
      '<p class="muted small">Baixa os preços do dia, o câmbio e os dados e regras das cartas. Faça uma vez antes de ir à loja: depois tudo funciona sem internet.</p>' +
      '<p class="small">Última atualização: <strong>' + (fmtDate(db.updatedAt) || 'nenhuma') + '</strong>' + (db.rate ? ' · US$ 1 = ' + brl.format(db.rate.brl) : '') + '</p>' +
      '<button class="btn primary full" data-act="refresh">' + ICON.refresh + 'Atualizar agora</button>' +
      '<p class="xs muted">O preço vem do Scryfall em dólar (mercado americano), convertido pelo câmbio do dia. É uma noção, não o preço da loja. Para o preço no Brasil, abra a carta e toque em "Ver preço na Liga Magic".</p></section>' +
      '<section class="card pad stack" aria-labelledby="fr"><h2 id="fr" style="font-size:1.0625rem">Lista de um amigo</h2>' +
      '<p class="muted small">Cole a lista que ele mandou. Eu mostro quais dessas cartas você tem marcadas nos seus decks.</p>' +
      '<label for="fl" class="visually-hidden">Lista do amigo</label><textarea id="fl" spellcheck="false" autocapitalize="off" style="min-height:140px" placeholder="4 Counterspell&#10;2 Wild Mongrel"></textarea>' +
      '<button class="btn full" data-act="friend">Ver o que eu tenho</button></section><div id="friendOut" aria-live="polite"></div>' +
      '<section class="card pad stack" aria-labelledby="bk"><h2 id="bk" style="font-size:1.0625rem">Backup no seu e-mail</h2>' +
      (nag ? '<p class="small" style="color:var(--miss);font-weight:700">' + (state.lastBackup ? 'Seu último backup está desatualizado.' : 'Você ainda não fez backup.') + '</p>' : '') +
      '<p class="muted small">Abre o compartilhar do Android: escolha o Gmail e mande para você mesmo. Para restaurar, baixe o anexo do e-mail e escolha o arquivo aqui.</p>' +
      '<p class="small">Último backup: <strong>' + (fmtDate(state.lastBackup) || 'nenhum') + '</strong></p>' +
      '<button class="btn full" data-act="backup">Enviar backup por e-mail</button>' +
      '<label class="btn full" for="restore" style="margin-top:8px">Restaurar de um arquivo</label>' +
      '<input type="file" id="restore" accept=".json,application/json" class="visually-hidden"></section>' +
      '<p class="xs muted">Dados, imagens e símbolos das cartas: Scryfall. Playset não é afiliado à Wizards of the Coast.</p></div>';
  }

  /* ---------- caderno de pesquisa ---------- */
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

  var TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  var tessLoading = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tessLoading) return tessLoading;
    tessLoading = new Promise(function (ok, fail) {
      var s = document.createElement('script');
      s.src = TESS; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = function () { window.Tesseract ? ok(window.Tesseract) : fail(new Error('tess')); };
      s.onerror = function () { tessLoading = null; fail(new Error('tess')); };
      document.head.appendChild(s);
    });
    return tessLoading;
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

  function viewResearch(d) {
    var sources = d.sources || [];
    var cons = FU.consensus(sources);
    var inDeck = {};
    d.cards.forEach(function (c) { inDeck[FU.key(canonical(c.name))] = (inDeck[FU.key(canonical(c.name))] || 0) + c.qty; });
    var withCards = sources.filter(function (s) { return s.cards && s.cards.length; }).length;
    var html = '<section class="sec"><h2 class="sec-h">Fontes <span class="c">(' + sources.length + ')</span></h2>';
    if (!sources.length) {
      html += '<div class="card pad stack" style="margin:4px 16px"><p><strong>Junte referências para montar a sua lista.</strong></p>' +
        '<p class="muted small">Adicione listas de torneio, decks de outros jogadores, prints e links. Eu mostro quais cartas aparecem em mais fontes, e você escolhe o que entra no seu deck.</p>' +
        '<a class="btn primary full" href="#/fonte/' + esc(d.id) + '">' + ICON.plus + 'Adicionar fonte</a></div>';
    } else {
      html += '<ul class="rows">' + sources.map(function (s) {
        var k = KIND[s.kind] || KIND.text;
        var n = (s.cards || []).reduce(function (a, c) { return a + c.qty; }, 0);
        return '<li class="r src"><span class="q" aria-hidden="true">' + k.icon + '</span>' +
          '<span class="nm" style="cursor:default">' + esc(s.label || k.label) +
          '<span class="d">' + k.label + ' · ' + (n ? n + ' cartas' : 'link salvo, sem cartas lidas') + ' · ' + esc(fmtDate(s.createdAt).split(' ')[0]) + '</span></span>' +
          (s.url ? '<a class="ib" href="' + esc(s.url) + '" target="_blank" rel="noopener" aria-label="Abrir ' + esc(s.label || 'link') + '">' + svg('<path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>') + '</a>' : '<span></span>') +
          '<button class="ib" data-delsrc="' + esc(s.id) + '" aria-label="Remover fonte ' + esc(s.label || k.label) + '">' + svg('<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>') + '</button></li>';
      }).join('') + '</ul><div style="padding:8px 16px"><a class="btn full" href="#/fonte/' + esc(d.id) + '">' + ICON.plus + 'Adicionar fonte</a></div>';
    }
    html += '</section>';
    if (!cons.length) return html;

    var missingAll = cons.filter(function (c) { return c.count === c.total && !inDeck[FU.key(canonical(c.name))]; });
    html += '<section class="sec"><h2 class="sec-h">Consenso <span class="c">(' + cons.length + ' cartas em ' + withCards + (withCards === 1 ? ' fonte' : ' fontes') + ')</span></h2>' +
      '<p class="xs muted" style="padding:0 16px 8px">Ordenado por quantas fontes usam a carta. Toque em + para colocar no seu deck com a quantidade mais comum.</p>';
    if (missingAll.length && withCards > 1) {
      html += '<div style="padding:0 16px 8px"><button class="btn full" data-addall>' + ICON.plus + 'Adicionar as ' + missingAll.length + ' que estão em todas as fontes</button></div>';
    }
    var tiers = [['Em todas as fontes', function (c) { return c.count === c.total; }], ['Na maioria', function (c) { return c.count < c.total && c.count / c.total > 0.5; }], ['Em algumas', function (c) { return c.count / c.total <= 0.5; }]];
    if (withCards === 1) tiers = [['Cartas da fonte', function () { return true; }]];
    tiers.forEach(function (t) {
      var list = cons.filter(t[1]);
      if (!list.length) return;
      html += '<h3 class="sec-h" style="font-size:.875rem;padding-top:10px">' + t[0] + ' <span class="c">(' + list.length + ')</span></h3><ul class="rows">';
      list.forEach(function (c) {
        var info = cardInfo(c.name);
        var have = inDeck[FU.key(canonical(c.name))];
        html += '<li class="r"><span class="q" aria-label="em ' + c.count + ' de ' + c.total + ' fontes" style="font-size:.8125rem;color:var(--muted)">' + c.count + '/' + c.total + '</span>' +
          '<button class="nm" data-card="' + esc(c.name) + '">' + esc(canonical(c.name)) + '<span class="d">' + c.qty + ' cópia' + (c.qty > 1 ? 's' : '') + (c.board === 'side' ? ' · sideboard' : '') + '</span></button>' +
          manaHtml(info && info.manaCost) +
          (have ? '<span class="own done" aria-label="Já está no deck com ' + have + '"><i>✓ ' + have + '</i></span>'
            : '<button class="own" data-addc="' + esc(c.name) + '" data-q="' + c.qty + '" data-b="' + c.board + '" aria-label="Adicionar ' + c.qty + ' ' + esc(canonical(c.name)) + ' ao deck"><i style="border-color:var(--accent);color:var(--accent)">+ ' + c.qty + '</i></button>') + '</li>';
      });
      html += '</ul>';
    });
    return html + '</section>';
  }

  /* rascunho da fonte em edição (só em memória) */
  var draft = null;
  function newDraft(deckId) { return { deckId: deckId, kind: 'text', label: '', url: '', text: '', stage: 'input', rows: null, busy: '', err: '' }; }

  function viewFonte(deckId) {
    var d = deckById(deckId);
    barAction.innerHTML = ''; fab.innerHTML = '';
    if (!d) return '<div class="card empty"><p>Deck não encontrado.</p></div>';
    if (!draft || draft.deckId !== deckId) draft = newDraft(deckId);
    var html = '<header class="head"><a href="#/deck/' + esc(d.id) + '" class="link" style="margin-left:-4px" data-dropdraft>' + ICON.back + esc(d.name) + '</a>' +
      '<h1>Adicionar fonte</h1></header>';

    if (draft.stage === 'review') return html + reviewHtml();

    html += '<form id="srcForm" class="form" novalidate>' +
      '<div><label for="st">Cole aqui</label><p class="small muted" id="sth" style="margin:0 0 8px">Um link, uma lista (ex.: 4 Counterspell) ou os dois. Se escrever um texto junto, ele vira o nome da fonte.</p>' +
      '<textarea id="st" aria-describedby="sth srcHint" spellcheck="false" autocapitalize="off" placeholder="https://moxfield.com/decks/…&#10;Campeão do torneio de outubro&#10;4 Counterspell">' + esc(draft.text) + '</textarea></div>' +
      '<div id="srcHint" class="small" aria-live="polite">' + srcHint(draft.text) + '</div>' +
      '<p id="srcErr" class="err" role="alert">' + esc(draft.err) + '</p>' +
      '<button class="btn primary full" type="submit">Salvar fonte</button>' +
      '<label class="btn full" for="si">' + KIND.image.icon + 'Anexar print de uma lista</label>' +
      '<input type="file" id="si" accept="image/*" class="visually-hidden">' +
      (draft.busy ? '<p class="small" role="status" aria-live="polite"><strong>' + esc(draft.busy) + '</strong></p>' : '') +
      '<p class="xs muted">Print funciona melhor com lista em texto (Moxfield em modo texto, WhatsApp). Eu leio, corrijo os nomes e mostro para você revisar. Na primeira vez precisa de internet.</p></form>';
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
    if (s.url && !n) out += '<p class="muted" style="margin-top:4px">Só o link fica salvo: os sites ainda não deixam o app ler as cartas pelo link. ' + (site ? esc(site[1]) + ': ' + esc(site[2]) : 'Para as cartas entrarem no consenso, cole a lista também.') + '</p>';
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
    d.sources.push({
      id: newId(), kind: draft.kind, label: draft.label.trim() || (draft.url ? (siteOf(draft.url) || [0, 'Link'])[1] : KIND[draft.kind].label + ' ' + (d.sources.length + 1)),
      url: (draft.url || '').trim(), cards: cards, createdAt: Date.now()
    });
    state.ui.view[d.id + ':tab'] = 'research';
    persist(true);
    var names = cards.map(function (c) { return c.name; }).filter(function (n) { var i = cardInfo(n); return !i || !i.typeLine; });
    draft = null;
    location.hash = '#/deck/' + d.id;
    toast('Fonte adicionada.');
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
    draft.url = s.url; draft.label = s.label; draft.kind = s.url ? 'link' : 'text';
    if (!s.url && !s.list.trim()) {
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

  function readImage(file) {
    readDraftInputs();
    var s0 = FU.splitSource(draft.text);
    draft.label = s0.label; draft.url = s0.url; draft.kind = 'image';
    draft.err = ''; draft.busy = 'Preparando o leitor…'; render();
    var worker;
    Promise.all([loadTesseract(), loadCatalog()]).then(function (res) {
      var T = res[0];
      draft.catalogMissing = !res[1];
      draft.busy = 'Lendo o print…'; render();
      return T.createWorker('eng', 1, {
        logger: function (m) {
          if (m.status === 'recognizing text' && draft) {
            var el = main.querySelector('[role=status] strong');
            if (el) el.textContent = 'Lendo o print… ' + Math.round(m.progress * 100) + '%';
          }
        }
      }).then(function (w) { worker = w; return w.recognize(file); }).then(function (r) {
        if (worker) worker.terminate();
        var text = FU.cleanOcr(r.data.text);
        var out = buildRows(text, res[1] || knownIndex());
        draft.busy = '';
        if (!out.rows.length) { draft.err = 'Não consegui ler cartas nesse print. Tente um print da lista em modo texto, sem cortar as linhas.'; render(); return; }
        draft.rows = out.rows; draft.stage = 'review'; render(); window.scrollTo(0, 0);
      });
    }).catch(function () {
      if (worker) try { worker.terminate(); } catch (e) {}
      draft.busy = '';
      draft.err = navigator.onLine ? 'Não consegui ler o print. Tente de novo ou mande o print para o Claude.' : 'Para ler print, conecte à internet (só na primeira vez).';
      render();
    });
  }

  function addToDeck(d, name, qty, board) {
    var nm = canonical(name);
    var ex = d.cards.filter(function (c) { return c.board === board && FU.key(canonical(c.name)) === FU.key(nm); })[0];
    if (ex) ex.qty = Math.max(ex.qty, qty);
    else d.cards.push({ name: nm, qty: qty, board: board === 'commander' ? 'commander' : (board === 'side' ? 'side' : 'main'), owned: 0 });
  }

  /* ---------- roteamento ---------- */
  function route() {
    var parts = (location.hash || '#/falta').replace(/^#\//, '').split('/');
    return { name: parts[0] || 'falta', id: parts[1] };
  }
  function render() {
    var r = route();
    var tab = ({ deck: 'decks', novo: 'decks', editar: 'decks', fonte: 'decks' })[r.name] || r.name;
    document.body.classList.toggle('home', ['decks', 'deck', 'novo', 'editar', 'mais', 'fonte'].indexOf(r.name) === -1);
    document.querySelectorAll('nav.tabs a').forEach(function (a) {
      if (a.getAttribute('data-tab') === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    var mais = document.querySelector('nav.tabs a[data-tab="mais"]');
    var pip = mais.querySelector('.pip');
    if (needsBackup() && !pip) mais.insertAdjacentHTML('beforeend', '<span class="pip"></span><span class="visually-hidden"> (backup pendente)</span>');
    if (!needsBackup() && pip) { pip.nextElementSibling.remove(); pip.remove(); }
    var titles = { falta: 'O que me falta', decks: 'Decks', mais: 'Mais', novo: 'Adicionar deck', editar: 'Editar deck', fonte: 'Adicionar fonte' };
    var d = r.name === 'deck' ? deckById(r.id) : null;
    document.title = (d ? d.name : (titles[r.name] || 'O que me falta')) + ' · Playset';
    if (r.name === 'decks') main.innerHTML = viewDecks();
    else if (r.name === 'deck') main.innerHTML = viewDeck(r.id);
    else if (r.name === 'novo') main.innerHTML = viewForm(null);
    else if (r.name === 'editar') main.innerHTML = viewForm(r.id);
    else if (r.name === 'mais') main.innerHTML = viewMais();
    else if (r.name === 'fonte') main.innerHTML = viewFonte(r.id);
    else main.innerHTML = viewFalta();
  }
  var lastRoute = null;
  function onRoute() {
    var key = location.hash;
    render();
    if (key !== lastRoute) { window.scrollTo(0, 0); main.focus({ preventScroll: true }); }
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
  function keepFocus(sel) { var el = main.querySelector(sel); if (el) el.focus({ preventScroll: true }); }

  main.addEventListener('input', function (e) {
    if (e.target.id !== 'st' || route().name !== 'fonte') return;
    var h = document.getElementById('srcHint');
    if (h) h.innerHTML = srcHint(e.target.value);
  });

  main.addEventListener('change', function (e) {
    if (e.target.id === 'si') { var f = e.target.files && e.target.files[0]; if (f) readImage(f); return; }
    if (e.target.hasAttribute('data-sortsel')) { state.ui.sort = e.target.value; persist(false); render(); keepFocus('#fSort'); return; }
    if (!e.target.hasAttribute('data-filter')) return;
    state.ui.deck = e.target.value; persist(false); render(); keepFocus('#fDeck');
  });

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-dropdraft]')) draft = null;
    var t = e.target.closest('button,[data-act]');
    if (!t || !(main.contains(t) || barAction.contains(t) || fab.contains(t))) return;
    if (t.hasAttribute('data-buy')) {
      var bc = t.getAttribute('data-buy');
      var bscope = bc === 'falta' ? (scopeDecks()) : [deckById(bc)];
      copyText(FU.toLigaMagic(FU.aggregateMissing(bscope, canonical)), 'Copiado. Cole no "Comprar por lista" da Liga Magic.');
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
    if (t.hasAttribute('data-addc') || t.hasAttribute('data-addall')) {
      var dk = deckById(route().id);
      if (!dk) return;
      var added = [];
      if (t.hasAttribute('data-addall')) {
        var inD = {};
        dk.cards.forEach(function (c) { inD[FU.key(canonical(c.name))] = 1; });
        FU.consensus(dk.sources).filter(function (c) { return c.count === c.total && !inD[FU.key(canonical(c.name))]; }).forEach(function (c) { addToDeck(dk, c.name, c.qty, c.board); added.push(c.name); });
      } else {
        addToDeck(dk, t.getAttribute('data-addc'), +t.getAttribute('data-q'), t.getAttribute('data-b'));
        added.push(t.getAttribute('data-addc'));
      }
      persist(true);
      var nameSel = t.hasAttribute('data-addc') ? t.getAttribute('data-addc') : null;
      var y = window.scrollY; render(); window.scrollTo(0, y);
      if (nameSel) { var nb = main.querySelector('[data-card="' + (window.CSS && CSS.escape ? CSS.escape(nameSel) : nameSel) + '"]'); if (nb) nb.focus({ preventScroll: true }); }
      toast(added.length === 1 ? 'Adicionada ao deck.' : added.length + ' cartas adicionadas ao deck.');
      var need = added.filter(function (n) { var i = cardInfo(n); return !i || !i.typeLine; });
      if (need.length) refreshPrices({ only: need, silent: true });
      return;
    }
    if (t.hasAttribute('data-onlymiss')) { state.ui.onlyMiss = !state.ui.onlyMiss; persist(false); render(); keepFocus('[data-onlymiss]'); return; }
    if (t.hasAttribute('data-card')) { openCard(t.getAttribute('data-card'), t); return; }
    if (t.hasAttribute('data-sort')) { state.ui.sort = t.getAttribute('data-sort'); persist(false); render(); keepFocus('[data-sort="' + state.ui.sort + '"]'); return; }
    if (t.hasAttribute('data-view')) { state.ui.view[route().id] = t.getAttribute('data-view'); persist(false); render(); keepFocus('[data-view="' + t.getAttribute('data-view') + '"]'); return; }
    if (t.hasAttribute('data-own')) {
      var d = deckById(route().id);
      var c = d && d.cards[+t.getAttribute('data-i')];
      if (!c) return;
      c.owned = c.owned >= c.qty ? 0 : c.qty;
      persist(true);
      var i = t.getAttribute('data-i');
      render();
      keepFocus('[data-own][data-i="' + i + '"]');
      return;
    }
    var act = t.getAttribute('data-act');
    var scope = scopeDecks();
    if (act === 'copyLiga') {
      copyText(FU.toLigaMagic(FU.aggregateMissing(scope, canonical)), 'Lista copiada. Cole no "Comprar por lista" da Liga Magic.');
    } else if (act === 'shareMissing') {
      shareText('O que me falta', 'Preciso destas cartas:\n' + FU.toLigaMagic(FU.aggregateMissing(scope, canonical)));
    } else if (act === 'refresh') {
      refreshPrices();
    } else if (act === 'copyDeckMissing') {
      copyText(FU.toLigaMagic(FU.aggregateMissing([deckById(t.getAttribute('data-id'))], canonical)), 'O que falta neste deck foi copiado.');
    } else if (act === 'deleteDeck') {
      var id = t.getAttribute('data-id');
      var deck = deckById(id);
      if (deck && confirm('Excluir o deck "' + deck.name + '"? Só dá para recuperar por um backup.')) {
        state.decks = state.decks.filter(function (x) { return x.id !== id; });
        persist(true);
        location.hash = '#/decks';
        toast('Deck excluído.');
      }
    } else if (act === 'example') {
      loadExamples();
    } else if (act === 'backup') {
      sendBackup();
    } else if (act === 'friend') {
      var txt = document.getElementById('fl').value;
      var out = document.getElementById('friendOut');
      if (!txt.trim()) { out.innerHTML = '<p class="err">Cole a lista do seu amigo primeiro.</p>'; return; }
      var res = FU.matchFriendList(txt, state.decks, canonical);
      if (!res.length) { out.innerHTML = '<p class="card pad">Você não tem nenhuma dessas cartas marcada nos seus decks.</p>'; return; }
      var reply = 'Tenho estas da sua lista:\n' + res.map(function (r) { return Math.min(r.have, r.wants) + ' ' + r.name; }).join('\n');
      out.innerHTML = '<section class="sec" style="margin:0 -16px"><h3 class="sec-h"><span>Você tem ' + res.length + ' da lista dele</span></h3><ul class="rows">' + res.map(function (r) {
        var info = cardInfo(r.name);
        return '<li class="r"><span class="qty">' + Math.min(r.have, r.wants) + '</span><button class="nm" data-card="' + esc(r.name) + '">' + esc(r.name) +
          '<span class="d">ele quer ' + r.wants + ' · você tem ' + r.have + ' nos decks</span></button>' + manaHtml(info && info.manaCost) + priceCell(info, 1) + '</li>';
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
    if (!name) { err.textContent = 'Dê um nome para o deck.'; document.getElementById('dn').focus(); return; }
    var parsed = FU.parseList(text);
    if (text.trim() && !parsed.cards.length) { err.textContent = 'Não encontrei cartas na lista. Use uma carta por linha, ex.: 4 Counterspell.'; document.getElementById('dl').focus(); return; }
    var deck;
    if (id) {
      deck = deckById(id);
      deck.name = name; deck.format = format;
      deck.cards = FU.mergeOwned(deck.cards, parsed.cards);
      persist(true);
    } else {
      deck = addDeck(name, format, text).deck;
      if (!deck.cards.length) state.ui.view[deck.id + ':tab'] = 'research';
    }
    location.hash = '#/deck/' + deck.id;
    toast((id ? 'Deck atualizado.' : 'Deck salvo.') + (parsed.skipped.length ? ' Ignorei ' + parsed.skipped.length + ' linha(s) que não eram cartas.' : ''));
    var fresh = deck.cards.map(function (c) { return c.name; }).filter(function (n) { var i = cardInfo(n); return !i || !i.typeLine; });
    if (fresh.length) refreshPrices({ only: fresh, silent: true });
  });

  main.addEventListener('change', function (e) {
    if (e.target.id !== 'restore') return;
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!data || data.app !== 'falta-uma' || !Array.isArray(data.state && data.state.decks)) throw new Error('formato');
        if (!confirm('Restaurar ' + data.state.decks.length + ' deck(s) do backup de ' + fmtDate(data.savedAt) + '? Os decks atuais serão substituídos.')) return;
        state = data.state;
        state.ui = state.ui || { sort: 'name', deck: 'all', view: {} };
        if (data.cards) db = data.cards;
        persist(false); persistDb();
        toast('Backup restaurado.');
        location.hash = '#/decks';
        render();
      } catch (er) { toast('Esse arquivo não é um backup do Playset.'); }
    };
    reader.readAsText(f);
  });

  function sendBackup() {
    var now = Date.now();
    var json = JSON.stringify({ app: 'falta-uma', version: 1, savedAt: now, state: state, cards: db });
    var d = new Date(now);
    var fname = 'playset-backup-' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '.json';
    var file = null;
    try { file = new File([json], fname, { type: 'application/json' }); } catch (e) {}
    var done = function () { state.lastBackup = now; persist(false); render(); toast('Backup pronto.'); };
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Backup Playset', text: 'Backup dos meus decks (Playset) de ' + fmtDate(now) }).then(done).catch(function () {});
    } else {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = fname;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      done();
      toast('Arquivo baixado. Anexe num e-mail para você.');
    }
  }

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
  window.addEventListener('online', function () { setStatus(); });
  if ('serviceWorker' in navigator && location.protocol === 'https:' && window.isSecureContext) {
    try { navigator.serviceWorker.register('sw.js').catch(function () {}); } catch (e) {}
  }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
})();
