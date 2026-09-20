/**
 * node 下跑 `.check.mts` 自检的模块解析钩子。
 *
 * 小程序运行时代码使用无扩展名相对导入（`./date`，由微信开发者工具解析），而 node ESM
 * 需要扩展名。本钩子让相对导入按原样解析，失败时以 `./date.ts` 重试，与开发者工具的分辨一致，
 * 这样纯逻辑自检（如 `utils/trainingStatus.check.mts`）能直接在 node 里跑。
 *
 * 用法：`node --import ./utils/ts-resolve-hooks.mjs utils/<name>.check.mts`
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      try {
        return nextResolve(specifier, context);
      } catch {
        // 已带扩展名就不要再拼 `.ts`（避免 `date.ts.ts`）。
        if (specifier.endsWith('.ts') || specifier.endsWith('.mts') || specifier.endsWith('.js')) {
          throw new Error(`cannot resolve relative import: ${specifier}`);
        }
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
