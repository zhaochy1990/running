import assert from 'node:assert/strict';
import { STORAGE_KEYS } from '../constants/config.ts';
import { beginRequestSession, clearSessionCredentials, http } from '../services/request.ts';

type Pending = { url: string; success(response: { statusCode: number; data: object; header: object }): void };
const storage = new Map<string, unknown>();
const pending: Pending[] = [];
let authenticated = false;
let recoveryAttempts = 0;
let loginRedirects = 0;
Object.assign(globalThis, {
  wx: {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
    request: (options: Pending) => pending.push(options),
    navigateTo: (options: { complete(): void }) => {
      loginRedirects++;
      options.complete();
    },
  },
  getCurrentPages: () => [],
  getApp: () => ({
    clearUserSession: logout,
    recoverSession: async () => {
      recoveryAttempts++;
      return false;
    },
  }),
});

function logout() {
  authenticated = false;
  clearSessionCredentials();
}

function login(accessToken = 'access') {
  beginRequestSession();
  authenticated = true;
  storage.set(STORAGE_KEYS.TOKEN, accessToken);
  storage.set(STORAGE_KEYS.REFRESH_TOKEN, 'refresh');
}

async function respond(url: RegExp, statusCode: number, data = {}) {
  await new Promise<void>((resolve) => setImmediate(resolve));
  const request = pending.shift();
  assert.ok(request);
  assert.match(request.url, url);
  request.success({ statusCode, data, header: {} });
}

const activities = '/api/user/activities?include=manual_strength';
login();
const staleRequest = assert.rejects(http.get(activities), { code: 'session_changed' });
await new Promise<void>((resolve) => setImmediate(resolve));
logout();
await respond(/activities/, 401);
await staleRequest;
assert.equal(pending.length, 0);
assert.equal(recoveryAttempts, 0);

login();
const staleRefresh = assert.rejects(http.get(activities), { code: 'session_changed' });
await respond(/activities/, 401);
logout();
await respond(/auth\/refresh/, 200, { access_token: 'stale token', refresh_token: 'stale refresh', expires_in: 60 });
await staleRefresh;
assert.equal(storage.has(STORAGE_KEYS.TOKEN), false);
assert.equal(recoveryAttempts, 0);

login();
const switchedRequest = assert.rejects(http.get(activities), { code: 'session_changed' });
await new Promise<void>((resolve) => setImmediate(resolve));
login('new account');
await respond(/activities/, 401);
await switchedRequest;
assert.equal(storage.get(STORAGE_KEYS.TOKEN), 'new account');
assert.equal(pending.length, 0);
assert.equal(recoveryAttempts, 0);

login();
const renewed = http.get(activities);
await respond(/activities/, 401);
await respond(/auth\/refresh/, 200, { access_token: 'renewed', refresh_token: 'new refresh', expires_in: 60 });
await respond(/activities/, 200, { activities: [] });
assert.deepEqual(await renewed, { activities: [] });
assert.equal(storage.get(STORAGE_KEYS.TOKEN), 'renewed');
assert.equal(recoveryAttempts, 0);

login();
const expired = assert.rejects(http.get(activities), { code: 'session_expired' });
await respond(/activities/, 401);
await respond(/auth\/refresh/, 401);
await expired;
assert.equal(authenticated, false);
assert.equal(storage.has(STORAGE_KEYS.TOKEN), false);
assert.equal(recoveryAttempts, 1);
assert.equal(loginRedirects, 1);
console.log('request-session.check: all assertions passed');
