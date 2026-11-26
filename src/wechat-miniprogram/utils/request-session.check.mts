import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as config from '../constants/config.ts';
import { STORAGE_KEYS } from '../constants/config.ts';
import * as requestService from '../services/request.ts';
import { http } from '../services/request.ts';
import { sendCoachChatStream } from '../services/coach.ts';

type Pending = { url: string; success(response: { statusCode: number; data: object; header: object }): void };
const storage = new Map<string, unknown>();
const pending: Pending[] = [];
let authenticated = false;
let activeRequests = requestService;
let recoveryAttempts = 0;
let loginRedirects = 0;
let attemptRecovery: () => Promise<boolean> = async () => false;
Object.assign(globalThis, {
  wx: {
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
    request: (options: Pending) => {
      pending.push(options);
      return { abort: () => undefined };
    },
    login: async () => ({ code: 'fresh code' }),
    navigateTo: () => { loginRedirects++; },
  },
  getCurrentPages: () => [],
  getApp: () => ({
    clearUserSession: logout,
    recoverSession: async () => {
      recoveryAttempts++;
      return attemptRecovery();
    },
  }),
});

function logout() {
  authenticated = false;
  activeRequests.clearSessionCredentials();
}

function login(accessToken = 'access') {
  activeRequests.beginRequestSession();
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
const streamErrors: string[] = [];
sendCoachChatStream('旧账号问题', 'old-dialogue', 'old-turn', undefined, {
  onError: (error) => streamErrors.push(error.code),
});
await respond(/coach\/chat/, 401);
login('new account');
await respond(/auth\/refresh/, 200, { access_token: 'old account', refresh_token: 'old refresh', expires_in: 60 });
await new Promise<void>((resolve) => setImmediate(resolve));
assert.deepEqual(streamErrors, ['session_changed']);
assert.equal(storage.get(STORAGE_KEYS.TOKEN), 'new account');
assert.equal(pending.length, 0);

login();
sendCoachChatStream('另一个旧账号问题', 'old-dialogue', 'old-turn-2', undefined, {
  onError: (error) => streamErrors.push(error.code),
});
await new Promise<void>((resolve) => setImmediate(resolve));
login('new account');
await respond(/coach\/chat/, 401);
assert.deepEqual(streamErrors, ['session_changed', 'session_changed']);
assert.equal(storage.get(STORAGE_KEYS.TOKEN), 'new account');
assert.equal(pending.length, 0);

login();
const completedMessages: string[] = [];
sendCoachChatStream('旧账号 JSON 回包', 'old-dialogue', 'old-turn-3', undefined, {
  onComplete: (result) => completedMessages.push(result.message),
  onError: (error) => streamErrors.push(error.code),
});
await new Promise<void>((resolve) => setImmediate(resolve));
login('new account');
await respond(/coach\/chat/, 200, { status: 'completed', message: '旧账号私密回复' });
assert.deepEqual(completedMessages, []);
assert.deepEqual(streamErrors, ['session_changed', 'session_changed', 'session_changed']);
assert.equal(storage.get(STORAGE_KEYS.TOKEN), 'new account');

function compiled(relative: string): string {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
}
const apiTypes = {};
runInNewContext(compiled('../types/api.ts'), { exports: apiTypes });
const authExports: { wechatLogin?: (redirect: boolean) => Promise<unknown> } = {};
runInNewContext(compiled('../services/auth.ts'), {
  exports: authExports,
  wx: globalThis.wx,
  console,
  require: (path: string) => ({ './request': requestService, '../constants/config': config, '../types/api': apiTypes })[path],
});
attemptRecovery = async () => {
  assert.ok(authExports.wechatLogin);
  try {
    await authExports.wechatLogin(false);
    return true;
  } catch {
    return false;
  }
};

login();
const expired = assert.rejects(http.get(activities), { code: 'session_expired' });
await respond(/activities/, 401);
await respond(/auth\/refresh/, 401);
await expired;
await respond(/oauth\/token/, 200, { access_token: 'provisional', refresh_token: 'provisional refresh', expires_in: 60 });
await respond(/\/api\/users\/me/, 503);
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(authenticated, false);
assert.equal(storage.has(STORAGE_KEYS.TOKEN), false);
assert.equal(recoveryAttempts, 1);
assert.equal(loginRedirects, 1);
activeRequests = await import('../services/request.ts?pending-recovery');
let finishOldRecovery: ((ok: boolean) => void) | undefined;
attemptRecovery = () => new Promise((resolve) => { finishOldRecovery = resolve; });
login('account A');
const expiredA = assert.rejects(activeRequests.http.get(activities), { code: 'session_expired' });
await respond(/activities/, 401);
await respond(/auth\/refresh/, 401);
await expiredA;
assert.equal(recoveryAttempts, 2);

login('account B');
const expiredB = assert.rejects(activeRequests.http.get(activities), { code: 'session_expired' });
await respond(/activities/, 401);
await respond(/auth\/refresh/, 401);
await expiredB;
assert.equal(authenticated, false);
assert.equal(storage.has(STORAGE_KEYS.TOKEN), false);
assert.equal(loginRedirects, 2);
finishOldRecovery?.(false);
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(loginRedirects, 2);
console.log('request-session.check: all assertions passed');
