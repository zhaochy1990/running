/**
 * sanitizeRedirect 自检：`node utils/redirect.check.mts`（或 `pnpm test`）。
 * 覆盖正常回跳、编码 round-trip、open-redirect 拒绝、坏输入。
 */
import { sanitizeRedirect } from './redirect.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) throw new Error(`${what}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const target = '/pages/race-center/strategy-share/strategy-share?user=u1&id=2&version=3';
eq(sanitizeRedirect(encodeURIComponent(target)), target, 'encodeURIComponent round-trip');
eq(sanitizeRedirect('/pages/coach/coach'), '/pages/coach/coach', 'plain internal path');
eq(sanitizeRedirect(encodeURIComponent('/pages/activity-detail/activity-detail?labelId=%E6%9D%AD')), '/pages/activity-detail/activity-detail?labelId=%E6%9D%AD', 'query with percent-escapes round-trips');

eq(sanitizeRedirect('https://evil.com/x'), '', 'reject absolute URL');
eq(sanitizeRedirect('javascript:alert(1)'), '', 'reject scheme');
eq(sanitizeRedirect('//evil.com'), '', 'reject protocol-relative');
eq(sanitizeRedirect('pages/coach/coach'), '', 'reject missing leading slash');
eq(sanitizeRedirect(''), '', 'empty');
eq(sanitizeRedirect(undefined), '', 'undefined');
eq(sanitizeRedirect('%zz'), '', 'bad percent-encoding');

console.log('redirect.check: all pass');
