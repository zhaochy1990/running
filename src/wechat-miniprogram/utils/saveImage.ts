/**
 * 保存图片到系统相册（devops#945，Epic #601 P3）——全仓首个相册保存 util。
 * 输入是 wx.canvasToTempFilePath 产出的 tempFilePath（页面先把海报画到
 * type="2d" canvas 再导出，先例 strategy.ts / workout-detail.ts），本模块
 * 只负责 wx.saveImageToPhotosAlbum 及 scope.writePhotosAlbum 被拒后的
 * openSetting 引导（标准套路）：
 *   1. 直接保存；fail 且判定为权限问题 → wx.getSetting 查 scope 值；
 *   2. scope undefined（从未问过，部分机型不弹系统窗直接 fail）→ wx.authorize 弹窗；
 *   3. scope false（明确拒绝过，authorize 不会再弹）→ showModal 引导 → wx.openSetting；
 *   4. 用户在设置里开启后自动重试保存一次。
 * 用户主动放弃（系统弹窗拒绝 / 不去设置）静默返回，不打扰。
 *
 * 判定逻辑（classifyAlbumSaveFail / albumAuthNext）是纯函数、不碰 wx，
 * node 侧自检见 saveImage.check.mts（进 CI 的 npm test 链）。
 */

/** saveImageToPhotosAlbum 失败的分档。 */
export type AlbumSaveFailKind = 'cancel' | 'auth' | 'other';

/**
 * 失败 errMsg → 分档。真机 / 开发者工具的 errMsg 变体：
 * - 权限拒绝：`saveImageToPhotosAlbum:fail auth deny`、`fail:auth denied`
 *   （冒号有无两种都出现过）、`fail authorize no response`
 * - 用户取消（部分安卓机型把 cancel 也走 fail 回调）：`fail cancel`
 * - 其余（文件不存在 / 存储满等）归 other，交调用方 toast。
 */
export function classifyAlbumSaveFail(errMsg: string): AlbumSaveFailKind {
  const msg = (errMsg || '').toLowerCase();
  if (msg.includes('cancel')) return 'cancel';
  if (msg.includes('auth deny') || msg.includes('auth denied') || msg.includes('authorize')) {
    return 'auth';
  }
  return 'other';
}

/**
 * 权限被拒后的下一步（依据 getSetting 里 scope.writePhotosAlbum 的值）：
 * undefined = 从未询问 → 走 wx.authorize 弹一次系统窗；
 * false = 用户明确拒绝过 → authorize 不再弹，只能 wx.openSetting 让用户手动开。
 */
export function albumAuthNext(scopeWritePhotosAlbum: boolean | undefined): 'authorize' | 'open-setting' {
  return scopeWritePhotosAlbum === false ? 'open-setting' : 'authorize';
}

/** saveImageToAlbum 的结果：成功保存 / 用户主动放弃（静默）/ 失败（调用方 toast）。 */
export type SaveAlbumResult = 'saved' | 'cancelled' | 'failed';

/** saveOnce 的内部档位：对外三档 + 权限被拒（走引导流程，不外露）。 */
type SaveOnceResult = SaveAlbumResult | 'auth-denied';

function saveOnce(tempFilePath: string): Promise<SaveOnceResult> {
  return new Promise((resolve) => {
    wx.saveImageToPhotosAlbum({
      filePath: tempFilePath,
      success: () => resolve('saved'),
      fail: (err) => {
        const kind = classifyAlbumSaveFail(err.errMsg);
        resolve(kind === 'cancel' ? 'cancelled' : kind === 'auth' ? 'auth-denied' : 'failed');
      },
    });
  });
}

/** 权限引导：authorize 或 openSetting，结束后 resolve 是否已拿到授权。 */
function ensureAlbumAuth(): Promise<boolean> {
  return new Promise((resolve) => {
    wx.getSetting({
      success: (res) => {
        const scope = res.authSetting['scope.writePhotosAlbum'];
        if (scope === true) {
          resolve(true); // 并发窗口里刚授权过，直接重试
          return;
        }
        if (albumAuthNext(scope) === 'authorize') {
          wx.authorize({
            scope: 'scope.writePhotosAlbum',
            success: () => resolve(true),
            fail: () => resolve(askOpenSetting()),
          });
          return;
        }
        resolve(askOpenSetting());
      },
      fail: () => resolve(false),
    });
  });
}

/** 明确拒绝过 → 弹窗引导进设置页开权限；用户不去 / 开了仍关着都算放弃。 */
function askOpenSetting(): Promise<boolean> {
  return new Promise((resolve) => {
    wx.showModal({
      title: '需要相册权限',
      content: '保存海报需要「添加到相册」权限，请在设置中开启',
      confirmText: '去设置',
      success: (res) => {
        if (!res.confirm) {
          resolve(false);
          return;
        }
        wx.openSetting({
          success: (s) => resolve(s.authSetting['scope.writePhotosAlbum'] === true),
          fail: () => resolve(false),
        });
      },
      fail: () => resolve(false),
    });
  });
}

/**
 * 保存 tempFilePath 到系统相册（权限拒绝自动引导 + 授权后重试一次）。
 * - 'saved'   保存成功（调用方 toast 成功提示）
 * - 'cancelled' 用户主动放弃：save 取消 / 引导弹窗点取消 / 设置页未开启（静默）
 * - 'failed'  非权限类失败或重试仍失败（调用方 toast 失败提示）
 */
export function saveImageToAlbum(tempFilePath: string): Promise<SaveAlbumResult> {
  return saveOnce(tempFilePath).then((result) => {
    if (result !== 'auth-denied') return result;
    return ensureAlbumAuth().then((granted) => {
      if (!granted) return 'cancelled' as const;
      // 授权后重试；此时再遇 auth-denied（理论不到）按失败口径交给调用方提示。
      return saveOnce(tempFilePath).then((retry): SaveAlbumResult =>
        retry === 'auth-denied' ? 'failed' : retry,
      );
    });
  });
}
