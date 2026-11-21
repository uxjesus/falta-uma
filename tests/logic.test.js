/* Testes das regras puras do Playset (logic.js). Rodar: node --test tests/  (sem instalar nada; precisa do Node 18+) */
const test = require('node:test');
const assert = require('node:assert/strict');
const FU = require('../logic.js');

test('parseList lê quantidade, nome e sideboard', () => {
  const p = FU.parseList('4 Counterspell\n3 Swords to Plowshares\n\nSideboard\n2 Disenchant');
  const by = (n) => p.cards.find((c) => c.name === n);
  assert.equal(by('Counterspell').qty, 4);
  assert.equal(by('Counterspell').board, 'main');
  assert.equal(by('Disenchant').board, 'side');
});

test('parseList aceita lista vazia sem quebrar', () => {
  assert.deepEqual(FU.parseList('').cards, []);
  assert.deepEqual(FU.parseList(null).cards, []);
});

test('aggregateMissing soma cópias entre decks, sem descontar compartilhadas, e ignora básicos', () => {
  const decks = [
    { id: 'a', name: 'A', cards: [{ name: 'Counterspell', qty: 4, owned: 0 }, { name: 'Island', qty: 10, owned: 0 }] },
    { id: 'b', name: 'B', cards: [{ name: 'Counterspell', qty: 4, owned: 1 }] },
  ];
  const r = FU.aggregateMissing(decks);
  assert.equal(r.length, 1);
  assert.equal(r[0].total, 7); // 4 + (4-1)
  assert.equal(r[0].decks.length, 2);
});

test('aggregateMissing não conta carta já completa nem passa de zero', () => {
  const r = FU.aggregateMissing([{ id: 'a', name: 'A', cards: [{ name: 'Brainstorm', qty: 2, owned: 5 }] }]);
  assert.deepEqual(r, []);
});

test('deckProgress ignora básicos e limita posse à quantidade', () => {
  const p = FU.deckProgress({ cards: [{ name: 'Island', qty: 20, owned: 0 }, { name: 'Ponder', qty: 4, owned: 9 }, { name: 'Brainstorm', qty: 4, owned: 0 }] });
  assert.deepEqual([p.need, p.have, p.pct], [8, 4, 50]);
});

test('deckComplete: Premodern exige 60+ no principal, 15 exatos no sideboard e tudo marcado', () => {
  const cards = [{ name: 'Counterspell', qty: 60, owned: 60, board: 'main' }, { name: 'Disenchant', qty: 15, owned: 15, board: 'side' }];
  assert.equal(FU.deckComplete({ format: 'Premodern', cards }), true);
  const sem = [{ name: 'Counterspell', qty: 60, owned: 60, board: 'main' }, { name: 'Disenchant', qty: 14, owned: 14, board: 'side' }];
  assert.equal(FU.deckComplete({ format: 'Premodern', cards: sem }), false);
  const falta = [{ name: 'Counterspell', qty: 60, owned: 59, board: 'main' }, { name: 'Disenchant', qty: 15, owned: 15, board: 'side' }];
  assert.equal(FU.deckComplete({ format: 'Premodern', cards: falta }), false);
});

test('deckComplete: Commander 100 cartas; lista avulsa e outros formatos nunca têm selo', () => {
  const cmd = [{ name: 'Cartas', qty: 100, owned: 100, board: 'main' }];
  assert.equal(FU.deckComplete({ format: 'Commander', cards: cmd }), true);
  assert.equal(FU.deckComplete({ format: 'Lista', cards: cmd }), false);
  assert.equal(FU.deckComplete({ format: 'Modern', cards: cmd }), false);
  assert.equal(FU.deckComplete(null), false);
});

test('markAllOwned só marca, nunca desmarca', () => {
  const cards = [{ name: 'A', qty: 4, owned: 1, board: 'main' }, { name: 'B', qty: 2, owned: 5, board: 'main' }, { name: 'C', qty: 3, owned: 0, board: 'maybe' }];
  FU.markAllOwned(cards);
  assert.deepEqual(cards.map((c) => c.owned), [4, 5, 0]);
});

test('b64url faz ida e volta, inclusive com acento', () => {
  const t = 'Mágica: Counterspell — Ação!';
  assert.equal(FU.b64urlDecode(FU.b64urlEncode(t)), t);
});

test('metaAgeDays conta dias e rejeita data inválida', () => {
  assert.equal(FU.metaAgeDays('2026-11-10', new Date(2026, 10, 20).getTime()), 10);
  assert.equal(FU.metaAgeDays('ontem'), null);
});

test('metaSplit separa amostra pequena, ordena pior primeiro e marca confrontos ruins', () => {
  const r = FU.metaSplit([{ o: 'X', wr: 60, n: 40 }, { o: 'Y', wr: 30, n: 20 }, { o: 'Z', wr: 10, n: 3 }]);
  assert.deepEqual(r.ok.map((x) => x.o), ['Y', 'X']);
  assert.deepEqual(r.few.map((x) => x.o), ['Z']);
  assert.deepEqual(r.bad.map((x) => x.o), ['Y']);
});

test('parseMeta lê o bloco da IA e ignora lixo', () => {
  const p = FU.parseMeta('PLAYSET-META v1\nfonte: MTG Decks\ndata: 2026-11-19\ndeck: Burn\nStiflenought|26|50\nlinha estranha');
  assert.equal(p.rows, 1);
  assert.equal(p.decks.Burn[0].o, 'Stiflenought');
  assert.equal(p.decks.Burn[0].wr, 26);
});

test('toLigaMagic gera quantidade + nome', () => {
  const t = FU.toLigaMagic([{ name: 'Counterspell', total: 4 }]);
  assert.match(t, /4\s+Counterspell/);
});

test('isBasic reconhece terrenos básicos e não confunde com outros', () => {
  assert.equal(FU.isBasic('Island'), true);
  assert.equal(FU.isBasic('Wasteland'), false);
});

test('regressão: funções de OCR foram removidas da API pública', () => {
  assert.equal(FU.cleanOcr, undefined);
  assert.equal(FU.parseMetaImage, undefined);
});

test('planList lê quantidades e aceita nomes sem quantidade', () => {
  assert.deepEqual(FU.planList('4 Meddling Mage, 1 Disenchant'), [{ q: 4, name: 'Meddling Mage' }, { q: 1, name: 'Disenchant' }]);
  assert.deepEqual(FU.planList('Compost, Waterfront Bouncer'), [{ q: null, name: 'Compost' }, { q: null, name: 'Waterfront Bouncer' }]);
  assert.deepEqual(FU.planList(''), []);
});

test('guias do Landstill: todo plano completo tem o mesmo número de cartas entrando e saindo, com fonte e data', () => {
  const opps = FU.sideNotesFor('Landstill');
  assert.ok(opps.length >= 15);
  opps.forEach((o) => {
    const n = FU.sideNote('Landstill', o);
    const a = n.plan.in.reduce((t, x) => t + x.q, 0), b = n.plan.out.reduce((t, x) => t + x.q, 0);
    assert.equal(a, b, 'plano desbalanceado contra ' + o);
    assert.ok(n.src.length && n.src[0].url && n.src[0].date, 'sem fonte/data: ' + o);
    assert.ok(n.lines.length && n.lines[0].length > 20);
  });
});

test('guias do Madness são parciais: sem quantidades inventadas e sem lista de saídas', () => {
  FU.sideNotesFor('Madness').forEach((o) => {
    const n = FU.sideNote('Madness', o);
    assert.equal(n.partial, true);
    assert.deepEqual(n.plan.out, []);
    n.plan.in.forEach((x) => assert.equal(x.q, null));
  });
});

test('sideNotesFor devolve vazio para arquétipo sem guia', () => {
  assert.deepEqual(FU.sideNotesFor('Psychatog'), []);
});

test('parseGuide lê um confronto, ignora conversa e cercas de código, e guarda ILEGIVEL à parte', () => {
  const r = FU.parseGuide('Claro, aqui vai:\n```\nADVERSÁRIO: Burn\nENTRA:\n- 4x Hydroblast\n2 Circle of Protection: Red\nSAI:\n2 Wrath of God\nILEGIVEL\nNOTAS:\n- Estabilize cedo\nFONTE: Fulano, site, 01/01/2026\n```');
  assert.equal(r.primer, null);
  assert.equal(r.guides.length, 1);
  const g = r.guides[0];
  assert.equal(g.opp, 'Burn');
  assert.deepEqual(g.in, [{ q: 4, name: 'Hydroblast' }, { q: 2, name: 'Circle of Protection: Red' }]);
  assert.deepEqual(g.out, [{ q: 2, name: 'Wrath of God' }]);
  assert.deepEqual(g.notes, ['Estabilize cedo']);
  assert.equal(g.src, 'Fulano, site, 01/01/2026');
  assert.equal(g.unreadable.length, 1);
  assert.equal(r.ignored, 1);
});

test('parseGuide sem ADVERSARIO vira o "Como jogar" do deck; vários confrontos viram vários guias', () => {
  const p = FU.parseGuide('NOTAS:\n- Mulligan agressivo\n- Combo X\nFONTE: Autor');
  assert.equal(p.guides.length, 0);
  assert.deepEqual(p.primer.notes, ['Mulligan agressivo', 'Combo X']);
  const m = FU.parseGuide('ADVERSARIO: A\nENTRA:\n1 Foo\nSAI:\n1 Bar\nADVERSARIO: B\nENTRA:\n1 Baz, 2 Qux\n');
  assert.deepEqual(m.guides.map((g) => g.opp), ['A', 'B']);
  assert.deepEqual(m.guides[1].in, [{ q: 1, name: 'Baz' }, { q: 2, name: 'Qux' }]);
});

test('parseGuide: texto sem o formato e linha de nota que começa com "Contra" não viram cabeçalho', () => {
  const x = FU.parseGuide('Não consegui ler o print, desculpe.');
  assert.equal(x.primer, null); assert.equal(x.guides.length, 0);
  const n = FU.parseGuide('NOTAS:\nContra aggro: jogue devagar\n- outra dica');
  assert.equal(n.primer.notes.length, 2);
});

test('guideTotals: confere se o que entra bate com o que sai e sabe quando falta quantidade', () => {
  assert.deepEqual(FU.guideTotals({ in: [{ q: 2 }], out: [{ q: 2 }] }), { in: 2, out: 2, known: true, balanced: true });
  assert.equal(FU.guideTotals({ in: [{ q: 3 }], out: [{ q: 2 }] }).balanced, false);
  const u = FU.guideTotals({ in: [{ q: null }], out: [] });
  assert.equal(u.known, false); assert.equal(u.balanced, false);
});

test('guidePrompt leva o deck, o formato e as regras de não inventar', () => {
  const p = FU.guidePrompt({ name: 'W Control', arch: 'Landstill', format: 'Premodern', main: '4 Counterspell', side: '2 Disenchant' });
  ['W Control', 'Landstill', '4 Counterspell', '2 Disenchant', 'ADVERSARIO:', 'ENTRA:', 'SAI:', 'NOTAS:', 'FONTE:', 'ILEGIVEL', 'Não invente'].forEach((k) => assert.ok(p.includes(k), 'falta ' + k));
});

test('parseGuide: "COMO JOGAR:" abre o primer mesmo depois de um confronto, na mesma resposta', () => {
  const r = FU.parseGuide('ADVERSARIO: Burn\nENTRA:\n1 Foo\nNOTAS:\n- dica do confronto\nFONTE: A\nCOMO JOGAR:\n- mulligan\n- combo\nFONTE: B');
  assert.equal(r.guides.length, 1);
  assert.deepEqual(r.guides[0].notes, ['dica do confronto']);
  assert.equal(r.guides[0].src, 'A');
  assert.deepEqual(r.primer.notes, ['mulligan', 'combo']);
  assert.equal(r.primer.src, 'B');
});

test('parseGuide: nomes de carta com vírgula ficam inteiros; várias cartas na linha só se cada uma tiver quantidade', () => {
  const r = FU.parseGuide('ADVERSARIO: A\nENTRA:\n1 Akroma, Angel of Wrath\n2 Urza, Lord Protector\n1 Teferi\'s Response, 2 Annul\nSAI:\n1 Jace, the Mind Sculptor');
  assert.deepEqual(r.guides[0].in.map((x) => x.name), ['Akroma, Angel of Wrath', 'Urza, Lord Protector', "Teferi's Response", 'Annul']);
  assert.equal(r.guides[0].out[0].name, 'Jace, the Mind Sculptor');
});

test('parseGuide: ENTRA/SAI sem ADVERSARIO não viram primer vazio', () => {
  const r = FU.parseGuide('ENTRA:\n1 A\nSAI:\n1 B');
  assert.equal(r.primer, null); assert.equal(r.guides.length, 0); assert.equal(r.errors.length, 1);
});

test('parseGuide: sufixo (tenho N), cabeçalho com contagem, x4, quantidades absurdas, tabela markdown', () => {
  const r = FU.parseGuide('ADVERSARIO: A\nENTRA (4):\nx4 Hydroblast\n2 Annul (tenho 2)\n| 3 | Disenchant |\n|---|---|\n0 Foo\n99999999999 Bar\nSAI (2):\n2 Wrath of God\nObs:');
  const i = r.guides[0].in;
  assert.deepEqual(i.slice(0, 3), [{ q: 4, name: 'Hydroblast' }, { q: 2, name: 'Annul' }, { q: 3, name: 'Disenchant' }]);
  assert.equal(i[3].q, null); assert.equal(i[4].q, null);
  assert.equal(r.guides[0].out.length, 1);
});

test('parseGuide: adversário repetido (caixa diferente) vira um só; nomes perigosos de objeto são renomeados', () => {
  const r = FU.parseGuide('ADVERSARIO: Burn\nENTRA:\n1 A\nADVERSARIO: burn\nENTRA:\n2 B\nADVERSARIO: __proto__\nNOTAS:\n- x');
  assert.equal(r.guides.length, 2); assert.equal(r.dupes, 1);
  assert.deepEqual(r.guides[0].in, [{ q: 2, name: 'B' }]);
  assert.ok(!/^__proto__$/i.test(r.guides[1].opp));
});

test('primer e guias sobrevivem a JSON (backup/restauração)', () => {
  const d = { primer: { lines: ['a'], src: 's', at: 1 }, mu: { Burn: { plan: { in: [{ q: 1, name: 'A' }], out: [] }, lines: [], src: [{ label: 'x' }], partial: false, unreadable: 0, at: 1 } } };
  assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
});

test('aggregateMissing conta cartas "maybe" e diz quantas são em consideração', () => {
  const decks = [{ id: 'a', name: 'A', cards: [{ name: 'Counterspell', qty: 4, owned: 2, board: 'main' }, { name: 'Powder Keg', qty: 2, owned: 0, board: 'maybe' }] },
    { id: 'b', name: 'B', cards: [{ name: 'Powder Keg', qty: 1, owned: 0, board: 'main' }] }];
  const r = FU.aggregateMissing(decks);
  const keg = r.find((x) => x.name === 'Powder Keg'), cs = r.find((x) => x.name === 'Counterspell');
  assert.equal(keg.total, 3); assert.equal(keg.maybe, 2); assert.equal(cs.maybe, 0);
});

test('considerAdd soma quantidade, separa principal e sideboard e limita a 99; considerRemove apaga o campo vazio', () => {
  const d = { cards: [] };
  FU.considerAdd(d, 'Powder Keg', 2, 'main'); FU.considerAdd(d, 'powder keg', 1, 'main'); FU.considerAdd(d, 'Powder Keg', 1, 'side');
  assert.deepEqual(d.consider, [{ name: 'Powder Keg', qty: 3, board: 'main' }, { name: 'Powder Keg', qty: 1, board: 'side' }]);
  FU.considerAdd(d, 'X', 500, 'main'); assert.equal(d.consider[2].qty, 99);
  assert.equal(FU.considerRemove(d, 'POWDER KEG'), 2);
  FU.considerRemove(d, 'X'); assert.equal(d.consider, undefined);
});

test('considerSuggestions: só cartas em 2+ fontes, fora do deck, da lista e das ignoradas', () => {
  const src = (cards) => ({ cards: cards.map(([name, qty, board]) => ({ name, qty, board: board || 'main' })) });
  const d = { cards: [{ name: 'Counterspell', qty: 4, board: 'main' }], sources: [
    src([['Counterspell', 4], ['Powder Keg', 2, 'side'], ['Exalted Angel', 2], ['Annul', 1]]),
    src([['Counterspell', 4], ['Powder Keg', 2, 'side'], ['Exalted Angel', 3], ['Disenchant', 1]]),
    src([['Powder Keg', 1, 'side'], ['Annul', 1]])], consider: [{ name: 'Annul', qty: 1, board: 'main' }], consNo: ['exalted angel'] };
  const s = FU.considerSuggestions(d);
  assert.deepEqual(s.map((x) => x.name), ['Powder Keg']);
  assert.equal(s[0].count, 3); assert.equal(s[0].total, 3); assert.equal(s[0].board, 'side');
  // com uma única lista, as cartas dela que faltam no deck já são sugeridas
  assert.deepEqual(FU.considerSuggestions({ cards: [], sources: [src([['A', 1]])] }).map((x) => x.name), ['A']);
});

test('considerSync: preenche uma vez, marca auto, não devolve o que foi removido e respeita o limite', () => {
  const src = (cards) => ({ cards: cards.map(([name, qty, board]) => ({ name, qty, board: board || 'main' })) });
  const d = { format: 'Premodern', cards: [{ name: 'Counterspell', qty: 4, board: 'main' }], sources: [
    src([['Counterspell', 4], ['Powder Keg', 2, 'side'], ['Annul', 1]]), src([['Powder Keg', 2, 'side'], ['Annul', 1], ['Wrath of God', 1]])] };
  assert.equal(FU.considerSync(d, null, 12), 2);
  assert.deepEqual(d.consider.map((x) => x.name).sort(), ['Annul', 'Powder Keg']);
  assert.ok(d.consider.every((x) => x.auto === 1 && x.cnt === 2 && x.tot === 2));
  assert.equal(FU.considerSync(d, null, 12), 0);
  // pessoa remove: vai para consNo e a carta não volta, mesmo com a lista vazia
  d.consider = []; d.consNo = ['Annul', 'Powder Keg'];
  assert.equal(FU.considerSync(d, null, 12), 0);
  // limite por rodada
  const big = { format: 'Premodern', cards: [], sources: [src(Array.from({ length: 30 }, (_, i) => ['Card' + i, 1]))] };
  assert.equal(FU.considerSync(big, null, 12), 12);
  assert.equal(FU.considerSync({ format: 'Lista', cards: [], sources: big.sources }, null, 12), 0);
});

test('considerNeed soma só o que falta, descontando o que a pessoa tem solto', () => {
  const d = { consider: [{ name: 'A', qty: 2 }, { name: 'B', qty: 1 }] };
  assert.equal(FU.considerNeed(d, (n) => (n === 'A' ? 1 : 5)), 1);
});
