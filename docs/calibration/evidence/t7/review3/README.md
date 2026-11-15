# T7 初审三项修复与 v3 实测

`79f10f5f` 的独立 Standards/Spec 初审指出三项 P2：iOS 心率半点使用了配速的 half-even、Web/小程序没有识别真实 HR 协议、小程序没有识别 `probable_maximal`。本目录记录修复后的新一轮身份／响应／截图；旧 v2 八案资料保留原位，不混用 hash，也不把旧结果冒充新代码验收。独立最终复评由总任务另行进行。

- HR 中心／范围端点统一为正数最接近整数、半点向上：166.5→167、168.5→169。配速继续只使用 Go 提供的 half-even 整秒；算法与数据库原值不改。
- `field_30min_last20_v1` 明示“场地测试协议（30分钟测试的后20分钟）”；`lab_lthr_report_v1` 明示“实验室乳酸阈值报告”，保留 `lactate_turnpoint` 等具体方法。
- canonical `probable_maximal` 明示“可能全力”，不提升模型支持，也不降成未知。

共享 JSON 增加 `producer-field-half`／`producer-lab-half`。新 Go test helper 用合成活动与明确测试元数据实际调用 `EstimateOfflineWithEvidence` → `SummarizeSource`，对共享冻结来源逐字段核对，再经 storage 发布、MySQL、GIN、真实 RS256 返回 HTTP。两个 HR 中心与方法、努力等级都来自真实 producer；166.5／168.5 的 HR 范围端点另作为**明确的 wire 舍入边界**附加，不是模型不确定性或准确性标签。

| 新案 | wire HR → 三端显示 | HR 范围 | HR 方法 | 配速努力 |
| --- | --- | --- | --- | --- |
| producer-field-half | 166.5 → 167 | 167–169 bpm | 30分钟测试后20分钟 | 可能全力 |
| producer-lab-half | 168.5 → 169 | 167–169 bpm | 实验室报告，lactate_turnpoint | 可能全力 |

两个新案的配速中心均由 producer 返回 null，三端保持“—”，不补旧值。[本轮10案实际响应 hash](response-hashes.json) 与三端独立实读逐一一致。

- Web：31 focused tests 与 build；实际 Chrome 10案页面／HTTP hash／数值／三日期，新增 HR范围、协议、可能全力、实验室方法 DOM 断言全通过，原触摸／键盘、390px、桌面和真实 offline→重试回归通过。[现场心率](web-producer-field-half-hr.png)、[现场努力](web-producer-field-half-effort.png)、[实验室心率](web-producer-lab-half-hr.png)、[实验室努力](web-producer-lab-half-effort.png)。
- 小程序：35条自检、tsc；实际10案页面与独立鉴权 HTTP hash全通过；两个 HR帮助真实 tap／scroll／读取协议／收起通过。[本轮4图与精确证据](../mp-review3/README.md)。
- iOS：392 tests／58 suites（显式本地 manifest，含10案真实 HTTP/VM及语义字面量），generic simulator build；实际原生8 tests／0 failures／0 skips（62.498s），新增 field／lab 的半点显示、范围、方法、质量门槛、可能全力，保留原6项含真实502→重试。upper-only／legacy／unknown／坏来源仍只算HTTP/VM回归，不冒充专门原生交互。[本轮12图及10案实读](../../../../walkthrough/devops-990/ios/review3/README.md)。首轮因代理未启动的环境尝试被中断，不计通过；代理恢复后完整8项重新运行。

三端 public projector 均先复现相关 RED 再修复为 GREEN；仅显示口径与映射改变。parity在修复后实际跨端核对基础上更新 aligned，不增加 confirmed，既有 iOS 无 zones表差异仍 pending。

CI另修复真实构建失败：Dockerfile.web 在 build stage COPY 同一 canonical JSON 到 `/app/docs/calibration/fixtures/`，保留对测试的类型检查；`.dockerignore` 没有排除该来源。`ci.yml` 的 frontend／小程序／Go consumer、`ios-app.yml` 的 PR/push、stride-web制品路径均覆盖 fixture-only 变更。真实 YAML+picomatch 评估由全部false转为全部true，普通截图README变更仍全部false。完整本地 Dockerfile.web build通过，运行时 index/assets与`nginx -t`通过，fixture不进入nginx文档目录，自有临时tag已删除；没有推送镜像或部署。

所有图片与 JSON只含合成工程信息；不提交身份、JWT、真实轨迹或备注。不读取 holdout/outcomes，不运行最终预测，不写生产或正式计划，生产仍 active3。前轮标准邮件 smoke 的 strength404基线证据保留，本轮不把它改称通过。
