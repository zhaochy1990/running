# vendor/ucharts

[uCharts](https://www.ucharts.cn/) 原生小程序版（npm 包 `@qiun/ucharts`，Apache-2.0），
单文件、无依赖、自带 canvas 2d 适配（会把旧版 `setStrokeStyle` 一类 API shim 到 2d context）。

- `u-charts.min.js` —— v2.5.0-20230101，来自 `npm pack @qiun/ucharts`，只改了一处：
  末尾的 `export default uCharts;` 改成 `module.exports = uCharts;`（+ `module.exports.default`）。
  小程序 JS 是 CommonJS，ESM 的 `export` 在运行时解析不了；升级时记得重复这步。

用到的能力：`type: 'line'` 折线（`extra.line.linearType: 'custom'` + `series[].linearColor`
做分区间配色）、`showToolTip` 触摸读数、`yAxis.data[].formatter` 自定义纵轴标签。

升级方式：

```bash
npm pack @qiun/ucharts
tar xzf qiun-ucharts-*.tgz package/u-charts.min.js
cp package/u-charts.min.js src/wechat-miniprogram/vendor/ucharts/u-charts.min.js
# 然后把文件末尾的 `export default uCharts;` 换成 module.exports（见上）
```
