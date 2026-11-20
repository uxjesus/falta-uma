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
