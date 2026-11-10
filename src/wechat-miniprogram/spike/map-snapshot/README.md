# spike/map-snapshot — 方案 A 三验证点复现 harness（stride-devops#943）

本目录已被 `project.config.json` 的 `packOptions.ignore` 排除，**不进小程序产物包**，仅供复现 spike 结论。完整结论与证据见仓库 `docs/spike/map-snapshot/README.md`。

## 复现步骤

1. 临时注册页面（跑完删掉这两处改动即可）：
   - `app.json` 的 `pages` 数组末尾加 `"spike/map-snapshot/spike-map-snapshot"`
   - `project.config.json` 的 `packOptions.ignore` 里临时移除 `spike` 目录条目
2. 启动微信开发者工具自动化端口：
   ```bash
   /Applications/wechatwebdevtools.app/Contents/MacOS/cli auto \
     --project <仓库>/src/wechat-miniprogram --auto-port 9421
   ```
3. 连接跑批（npm 包 `miniprogram-automator`）：
   ```js
   const automator = require('miniprogram-automator');
   const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9421' });
   const page = await mp.reLaunch('/spike/map-snapshot/spike-map-snapshot');
   // 轮询 page.data().results 直到出现 id === 'SUM'，再 mp.screenshot() 留证
   ```
4. 页面无需任何后端数据：轨迹是合成的世纪公园 GCJ-02 椭圆环线（72 点），起终点 marker 复用 `/assets/icons/map_dot.png`。

验证点与判定结论以仓库 `docs/spike/map-snapshot/README.md` 为准（V1 fail：snapshot API 不存在；V2 pass；V3 仅 region 计算可用）。
