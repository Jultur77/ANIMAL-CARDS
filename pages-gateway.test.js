import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

// Tests du suivi local avec transport simulé : aucun SDK ou service distant.
const source = await readFile(new URL('./pages/firebase-client.js', import.meta.url), 'utf8');
const marker = 'const identifier =';
assert.equal(source.split(marker).length, 2, 'Début du module client ambigu');
const executable = source.slice(source.indexOf(marker))
  .replace('export function userMessage', 'function userMessage')
  .replace('export class GameGateway', 'class GameGateway');
const checks = [];
const expectedChecks = 11;
function world() {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  const context = vm.createContext({ crypto: { randomUUID }, localStorage: storage,
    firebaseConfig: { projectId: 'demo-animal-cards-gateway' } });
  vm.runInContext(`${executable}\nglobalThis.api = { GameGateway, userMessage };`, context);
  const gateway = Object.create(context.api.GameGateway.prototype);
  gateway.auth = { currentUser: { uid: 'alice' } };
  gateway.busy = false;
  gateway.pendingError = '';
  gateway.callAction = async action => ({ data: { id: action.id, kind: action.kind, alreadyApplied: false, revealed: [] } });
  return { gateway, storage, values, userMessage: context.api.userMessage };
}
const plain = value => JSON.parse(JSON.stringify(value));
const failure = code => Object.assign(new Error('Échec simulé'), { code });
function check(label, operation) {
  test(label, async () => { await operation(); checks.push(label); });
}

check('Action sauvegardée avant envoi, sans auteur ni état économique fournis au transport', async () => {
  const { gateway } = world();
  let sent;
  gateway.callAction = async action => {
    sent = plain(action);
    assert.equal(gateway.pending().id, action.id);
    assert.equal(gateway.busy, true);
    return { data: { ...action, alreadyApplied: false, revealed: [] } };
  };
  const result = await gateway.action('reserve', { slot: 0, tier: 0 });
  assert.deepEqual(Object.keys(sent).sort(), ['data', 'id', 'kind']);
  assert.deepEqual(sent.data, { slot: 0, tier: 0 });
  assert.equal(result.id, sent.id);
  assert.equal(gateway.pending(), null);
  assert.equal(gateway.busy, false);
});

check('Réponse perdue : reprise avec le même identifiant et récupération des cartes révélées', async () => {
  const { gateway } = world();
  let original;
  gateway.callAction = async action => { original = plain(action); throw failure('functions/unavailable'); };
  await assert.rejects(gateway.action('open'));
  assert.equal(gateway.pending().id, original.id);
  await assert.rejects(gateway.action('claim'), /transaction en attente/);
  gateway.callAction = async action => {
    assert.deepEqual(plain(action), original);
    return { data: { id: action.id, kind: action.kind, alreadyApplied: true,
      revealed: ['red-fox', 'rabbit', 'clownfish', 'monarch'] } };
  };
  const result = await gateway.retryPending();
  assert.equal(result.alreadyApplied, true);
  assert.equal(result.revealed.length, 4);
  assert.equal(gateway.pending(), null);
});

check('Rejet certain d’une première tentative : suivi local libéré', async () => {
  for (const code of ['invalid-argument', 'permission-denied', 'failed-precondition', 'unauthenticated']) {
    const { gateway } = world();
    gateway.callAction = async () => { throw failure(`functions/${code}`); };
    await assert.rejects(gateway.action('claim'));
    assert.equal(gateway.pending(), null, code);
    assert.equal(gateway.busy, false);
  }
});

check('Rejet pendant une reprise : ne pas oublier une première tentative au résultat inconnu', async () => {
  const { gateway } = world();
  gateway.callAction = async () => { throw failure('functions/deadline-exceeded'); };
  await assert.rejects(gateway.action('claim'));
  const id = gateway.pending().id;
  gateway.callAction = async () => { throw failure('functions/unauthenticated'); };
  await assert.rejects(gateway.retryPending());
  assert.equal(gateway.pending().id, id);
  assert.equal(gateway.busy, false);
});

check('Erreurs ambiguës conservées pour une reprise sans doublon', async () => {
  for (const code of ['functions/aborted', 'functions/internal', 'functions/resource-exhausted', 'unknown']) {
    const { gateway } = world();
    gateway.callAction = async () => { throw failure(code); };
    await assert.rejects(gateway.action('claim'));
    assert.equal(gateway.pending().kind, 'claim', code);
  }
});

check('Confirmation illisible : identifiant conservé et absence de faux succès', async () => {
  for (const result of [null, {}, { id: 'another_id', kind: 'claim', alreadyApplied: false, revealed: [] }]) {
    const { gateway } = world();
    gateway.callAction = async () => ({ data: result });
    await assert.rejects(gateway.action('claim'), /Confirmation serveur illisible/);
    assert.ok(gateway.pending());
  }
});

check('Stockage indisponible : aucun appel envoyé sans suivi local', async () => {
  const { gateway, storage } = world();
  let calls = 0;
  gateway.callAction = async () => { calls++; };
  storage.setItem = () => { throw new Error('Stockage bloqué'); };
  await assert.rejects(gateway.action('claim'), /Stockage bloqué/);
  assert.equal(calls, 0);
  assert.equal(gateway.busy, false);
});

check('Suivi corrompu ou appartenant à un autre compte : aucun nouvel achat envoyé', async () => {
  for (const raw of ['{broken', JSON.stringify({ id: randomUUID(), actor: 'bruno', kind: 'claim', data: {} })]) {
    const { gateway, storage } = world();
    storage.setItem(gateway.pendingKey(), raw);
    let calls = 0;
    gateway.callAction = async () => { calls++; };
    await assert.rejects(gateway.action('reserve', { slot: 0, tier: 0 }), /inaccessible ou illisible/);
    assert.equal(calls, 0);
  }
});

check('Appel concurrent local, absence de session et reprise vide refusés', async () => {
  const { gateway } = world();
  let release;
  gateway.callAction = action => new Promise(resolve => {
    release = () => resolve({ data: { id: action.id, kind: action.kind, alreadyApplied: false, revealed: [] } });
  });
  const first = gateway.action('claim');
  await assert.rejects(gateway.action('claim'), /déjà en cours/);
  release();
  await first;
  await assert.rejects(gateway.retryPending(), /aucune transaction/);
  gateway.auth.currentUser = null;
  await assert.rejects(gateway.action('claim'), /Connecte-toi/);
});

check('Suivis séparés par compte et projet', async () => {
  const { gateway } = world();
  gateway.callAction = async () => { throw failure('functions/unavailable'); };
  await assert.rejects(gateway.action('claim'));
  const aliceKey = gateway.pendingKey();
  const aliceId = gateway.pending().id;
  gateway.auth.currentUser = { uid: 'bruno' };
  assert.notEqual(gateway.pendingKey(), aliceKey);
  assert.equal(gateway.pending(), null);
  gateway.auth.currentUser = { uid: 'alice' };
  assert.equal(gateway.pending().id, aliceId);
});

check('Messages Auth et Functions correctement reconnus, sans conseil d’ouvrir les écritures', async () => {
  const { userMessage } = world();
  assert.match(userMessage(failure('auth/invalid-email')), /adresse e-mail/);
  assert.match(userMessage(failure('functions/unavailable')), /transaction en attente/);
  assert.match(userMessage(failure('functions/permission-denied')), /écritures directes doivent rester interdites/);
  assert.match(userMessage(failure('functions/aborted')), /même identifiant/);
  assert.equal(userMessage({ code: 'functions/failed-precondition', message: 'Solde insuffisant' }), 'Solde insuffisant');
});

after(async () => {
  await mkdir('.frst', { recursive: true });
  await writeFile('.frst/pages-gateway-test-result.json', JSON.stringify({
    status: checks.length === expectedChecks ? 'passed' : 'failed', checkCount: checks.length,
    expectedChecks, checks, transport: 'simulated', firebaseSdkVerified: false,
    callableHttpVerified: false, finishedAt: new Date().toISOString()
  }, null, 2));
});
