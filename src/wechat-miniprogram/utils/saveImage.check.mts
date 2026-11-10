// saveImage.ts 自检：`node --import ./utils/ts-resolve-hooks.mjs utils/saveImage.check.mts`。
// 覆盖 devops#945 三路的判定核心：保存失败 errMsg 分档（权限拒/取消/其它）
// 与权限被拒后的动作选择（authorize vs openSetting）。模块在 node 侧无 wx
// 全局也能 import 本身即是断言：wx 只在函数体内触碰（顶层零副作用）。
import { albumAuthNext, classifyAlbumSaveFail, saveImageToAlbum } from './saveImage.ts';

function eq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: got ${a}, want ${e}`);
}

// ── classifyAlbumSaveFail：真机 errMsg 变体分档 ──
eq(classifyAlbumSaveFail('saveImageToPhotosAlbum:fail auth deny'), 'auth', 'auth deny (android)');
eq(classifyAlbumSaveFail('saveImageToPhotosAlbum:fail:auth denied'), 'auth', 'auth denied (colon variant)');
eq(classifyAlbumSaveFail('saveImageToPhotosAlbum:fail authorize no response'), 'auth', 'authorize no response');
eq(classifyAlbumSaveFail('saveImageToPhotosAlbum:fail cancel'), 'cancel', 'user cancel via fail');
eq(classifyAlbumSaveFail('saveImageToPhotosAlbum:fail file not exist'), 'other', 'file error is other');
eq(classifyAlbumSaveFail('saveImageToPhotosAlbum:fail sdcard not mounted'), 'other', 'storage error is other');
eq(classifyAlbumSaveFail(''), 'other', 'empty errMsg is other');
eq(classifyAlbumSaveFail('SAVEIMAGETOPHOTOSALBUM:FAIL AUTH DENY'), 'auth', 'case-insensitive');

// ── albumAuthNext：scope 值 → 引导动作 ──
eq(albumAuthNext(false), 'open-setting', 'explicit deny needs openSetting');
eq(albumAuthNext(undefined), 'authorize', 'never asked goes authorize first');
// true 不会进引导流程（saveOnce 已成功），authorize 分支只是兜底默认值
eq(albumAuthNext(true), 'authorize', 'granted falls to default (not reached in flow)');

// ── 对外形态 ──
if (typeof saveImageToAlbum !== 'function') throw new Error('saveImageToAlbum must be a function');

console.log('saveImage.check: all assertions passed');
