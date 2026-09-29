import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ACCOUNT_TTL_MS, accountInfo, Auth, authConfigFromEnv, bearer, cookie, returnAllowed, SESSION_DAYS, type GitHubApi } from './auth.ts';
import { FileProjectStore, type StoredAccount } from './store.ts';

const CONFIG = { clientId: 'id', clientSecret: 'shh', secret: 'shh', scope: 'read:user repo' };
const CALLBACK = 'https://indexer.test/api/auth/github/callback';

function fakeGitHub(user = { id: 42, login: 'ada', name: 'Ada' }): GitHubApi & { codes: string[] } {
  const codes: string[] = [];
  return {
    codes,
    async exchange(code, redirectUri) {
      assert.equal(redirectUri, CALLBACK);
      codes.push(code);
      return { token: `gho_${code}`, scopes: 'read:user,repo' };
    },
    async user() {
      return user;
    },
    async repos() {
      return ['ada/private-thing', 'ada/notes'];
    },
  };
}

async function setup(now = () => 1_000_000_000_000) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-auth-'));
  const store = new FileProjectStore(home);
  const github = fakeGitHub();
  return { home, store, github, auth: new Auth(store, CONFIG, github, now) };
}

/** Signs in as the fake GitHub user, the way the callback does. */
async function signIn(auth: Auth, returnTo = 'https://fiada.tech/') {
  const { url, nonce } = auth.begin(returnTo, CALLBACK);
  const state = new URL(url).searchParams.get('state')!;
  return auth.finish('code1', state, nonce, CALLBACK);
}

test('sign-in is off unless both GitHub client variables are set', () => {
  assert.equal(authConfigFromEnv({}), null);
  assert.equal(authConfigFromEnv({ FIADA_GITHUB_CLIENT_ID: 'x' }), null);
  const c = authConfigFromEnv({ FIADA_GITHUB_CLIENT_ID: 'x', FIADA_GITHUB_CLIENT_SECRET: 'y' });
  assert.equal(c?.secret, 'y');
  assert.match(c!.scope, /\brepo\b/);
  assert.equal(authConfigFromEnv({ FIADA_GITHUB_CLIENT_ID: 'x', FIADA_GITHUB_CLIENT_SECRET: 'y', FIADA_SESSION_SECRET: 'z' })?.secret, 'z');
});

test('signing in saves the account with its GitHub token sealed, and hands back a session', async () => {
  const { auth, store, home, github } = await setup();
  const { account, returnTo, session } = await signIn(auth);
  assert.equal(returnTo, 'https://fiada.tech/');
  assert.equal(account.id, 'gh-42');
  assert.deepEqual(github.codes, ['code1']);
  const saved = await store.loadAccount('gh-42');
  assert.equal(saved?.login, 'ada');
  assert.ok(!JSON.stringify(saved).includes('gho_code1'), 'the GitHub token is not stored as given');
  assert.equal(await auth.githubToken('gh-42'), 'gho_code1');
  assert.equal((await fs.stat(path.join(home, 'accounts', 'gh-42.json'))).mode & 0o777, 0o600);
  assert.equal((await auth.session(session))?.id, 'gh-42');
  assert.equal(accountInfo(account).privateRepos, true);
  assert.deepEqual(await auth.recentRepos('gh-42'), ['ada/private-thing', 'ada/notes']);
});

test('a sign-in finishes only in the browser that started it, and only once its state is genuine', async () => {
  const { auth } = await setup();
  const { url, nonce } = auth.begin('https://fiada.tech/', CALLBACK);
  const state = new URL(url).searchParams.get('state')!;
  await assert.rejects(auth.finish('c', state, 'another-browser', CALLBACK), /another browser/);
  await assert.rejects(auth.finish('c', state, undefined, CALLBACK), /another browser/);
  await assert.rejects(auth.finish('c', `${state}x`, nonce, CALLBACK), /expired/);
  await assert.rejects(auth.finish(undefined, state, nonce, CALLBACK), /did not sign you in/);
  assert.equal(auth.returnOf(state), 'https://fiada.tech/');
  assert.equal(auth.returnOf('forged.state'), null);
});

test('sessions expire, and forged or cross-kind tokens are refused', async () => {
  let t = 1_000_000_000_000;
  const { auth } = await setup(() => t);
  const { account, session } = await signIn(auth);
  const agent = auth.agentToken(account);
  assert.equal((await auth.agent(agent))?.id, 'gh-42');
  // An agent token opens no session, and a session reports no agent.
  assert.equal(await auth.session(agent), null);
  assert.equal(await auth.agent(session), null);
  // Tampered payload, same signature.
  const [body, sig] = session.split('.');
  const forged = `fs_${Buffer.from(JSON.stringify({ k: 's', u: 'gh-7', x: 9e9 })).toString('base64url')}.${sig}`;
  assert.notEqual(body, forged.split('.')[0]);
  assert.equal(await auth.session(forged), null);
  assert.equal(await auth.session(undefined), null);
  // Another indexer's secret signs nothing here.
  const other = new Auth((auth as any).store, { ...CONFIG, secret: 'other' }, fakeGitHub(), () => t);
  assert.equal(await other.session(session), null);
  t += (SESSION_DAYS + 1) * 86400_000;
  assert.equal(await auth.session(session), null);
  assert.equal((await auth.agent(agent))?.id, 'gh-42', 'agent tokens last until they are reset');
});

test('a new agent token stops the old one', async () => {
  const { auth } = await setup();
  const { account } = await signIn(auth);
  const old = auth.agentToken(account);
  const fresh = await auth.resetAgentToken(account);
  assert.equal(await auth.agent(old), null);
  assert.equal((await auth.agent(fresh))?.id, 'gh-42');
  // Signing in again keeps the new token working.
  await signIn(auth);
  assert.equal((await auth.agent(fresh))?.id, 'gh-42');
});

test('a token reset on another indexer sharing the store takes effect here too', async () => {
  let t = 1_000_000_000_000;
  const { auth: one, store } = await setup(() => t);
  const { account } = await signIn(one);
  const old = one.agentToken(account);
  // A second indexer on the same store, which has already read the account.
  const two = new Auth(store, CONFIG, fakeGitHub(), () => t);
  assert.equal((await two.agent(old))?.id, 'gh-42');

  const fresh = await one.resetAgentToken(account);
  // The new token is newer than what `two` read, so it reads again at once.
  assert.equal((await two.agent(fresh))?.id, 'gh-42');
  assert.equal(await two.agent(old), null);

  // An old token that `two` has read the account for keeps working only until that read goes stale.
  const newest = one.agentToken((await store.loadAccount('gh-42'))!);
  await one.resetAgentToken((await store.loadAccount('gh-42'))!);
  assert.equal((await two.agent(newest))?.id, 'gh-42', 'within the TTL, the read still stands');
  t += ACCOUNT_TTL_MS + 1;
  assert.equal(await two.agent(newest), null, 'after the TTL, the reset applies');
});

test('signing in or resetting on an indexer with a stale read keeps the latest agent epoch', async () => {
  const { auth: one, store } = await setup();
  const { account } = await signIn(one);
  const two = new Auth(store, CONFIG, fakeGitHub());
  // `two` reads the account at epoch 0, then `one` resets it to 1.
  assert.equal((await two.agent(one.agentToken(account)))?.id, 'gh-42');
  const afterOne = await one.resetAgentToken(account);
  // Signing in on `two` must not write epoch 0 back.
  await signIn(two);
  assert.equal((await store.loadAccount('gh-42'))?.agentEpoch, 1);
  assert.equal((await one.agent(afterOne))?.id, 'gh-42');
  // Resetting on `two` with its stale account moves past 1, not back to it.
  const afterTwo = await two.resetAgentToken(account);
  assert.equal((await store.loadAccount('gh-42'))?.agentEpoch, 2);
  assert.equal((await two.agent(afterTwo))?.id, 'gh-42');
  assert.equal(await two.agent(afterOne), null);
});

test('a sealed token opens only with the secret that sealed it', async () => {
  const { auth, store } = await setup();
  const sealed = auth.seal('gho_secret');
  assert.equal(auth.unseal(sealed), 'gho_secret');
  assert.equal(new Auth(store, { ...CONFIG, secret: 'rotated' }, fakeGitHub()).unseal(sealed), null);
  assert.equal(auth.unseal('garbage'), null);
});

test('the session goes back only to the indexer itself or an allowed origin', () => {
  const allowed = (o: string) => o === 'https://fiada.tech';
  assert.equal(returnAllowed('https://fiada.tech/', 'https://indexer.test', allowed), true);
  assert.equal(returnAllowed('http://localhost:5178/', 'http://localhost:5178', allowed), true);
  assert.equal(returnAllowed('https://evil.test/', 'https://indexer.test', allowed), false);
  assert.equal(returnAllowed('https://fiada.tech.evil.test/', 'https://indexer.test', allowed), false);
  assert.equal(returnAllowed('javascript:alert(1)', 'https://indexer.test', () => true), false);
  assert.equal(returnAllowed('not a url', 'https://indexer.test', allowed), false);
});

test('headers: the bearer token and a cookie by name', () => {
  assert.equal(bearer('Bearer abc.def'), 'abc.def');
  assert.equal(bearer('bearer  abc '), 'abc');
  assert.equal(bearer('Basic abc'), undefined);
  assert.equal(bearer(undefined), undefined);
  assert.equal(cookie('a=1; fiada_oauth=xyz; b=2', 'fiada_oauth'), 'xyz');
  assert.equal(cookie('fiada_oauth_old=1', 'fiada_oauth'), undefined);
  assert.equal(cookie(undefined, 'fiada_oauth'), undefined);
});

test('accounts round-trip through the file store', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fiada-acct-'));
  const store = new FileProjectStore(home);
  const a: StoredAccount = { id: 'gh-1', githubId: 1, login: 'x', sealedToken: 's', scopes: 'repo', agentEpoch: 0, createdAt: 't', updatedAt: 't' };
  assert.equal(await store.loadAccount('gh-1'), null);
  await store.saveAccount(a);
  assert.deepEqual(await store.loadAccount('gh-1'), a);
  await assert.rejects(store.loadAccount('../etc'), /Invalid project id/);
});
