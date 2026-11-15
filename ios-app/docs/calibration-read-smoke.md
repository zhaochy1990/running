# 阈值解释本地只读 smoke（#990）

使用 `docs/calibration/fixtures/client-display-v1.json` 的统一工程案例。它们仅验证工程行为，不是准确性或候选上线证据。生产仍 active=v3，候选 release_ready=false。

`CalibrationDisplayTests` 读取同一份 fixture，核对服务端整数秒/km、快慢范围方向、单侧约束、HR、证据日、输入截止日和上海执行时刻；客户端不从 m/s 另算能力。`CalibrationLocalServiceTests` 在显式环境变量存在时，通过真实 URLSession/APIClient、签名 JWT 和隔离 MySQL+Gin 服务逐案验证原始响应 SHA256，并经普通 AppModel.bootstrap → TrainingStatusModel 五端点读取页面模型。不会注册真实用户、读写生产或打印 token。连接拒绝用真实 URLSession 的 loopback 网络错误验证，不能把它写成页面错误交互已验收。

```sh
cd ios-app/StrideKit
STRIDE_LOCAL_READ_MANIFEST=/private/path/client-server.json swift test
```

Simulator 使用专属设备，不能接管已有用户设备。在已安装的 DEBUG app 私有 `Documents/StrideLocalRead.json` 写入 0600 本地配置：根 `url` 必须精确为 `http://127.0.0.1:19890`，`cases` 保存每案 `name` 和有效本地 `token`。可直接从受控 manifest 投影这些字段；文件不进入 Git、截图、issue 或启动参数。单案配置 `{url,token}` 同样可用。

`-StrideLocalRead` 只在 DEBUG Simulator 装配本地 URLSession 客户端；普通 bootstrap 仍向本地服务验证身份，然后进入训练状态。所有数据、身份、教练地址都绑定同一 loopback 地址，不能把配置 token 发往生产。`-StrideLocalReadCase <name>` 在私有文件里选择案例，不接受 token 参数。

```sh
xcodebuild -project ios-app/Stridewise.xcodeproj -scheme StridewiseCalibrationSmoke \
  -destination 'platform=iOS Simulator,id=<owned-device>' \
  -derivedDataPath /private/path/derived CODE_SIGNING_ALLOWED=NO test
```

专用 scheme 才启用本域 UI smoke；正常 Stridewise scheme 的测试配置保持原样。UI 测试实际点击说明，检查三日期和 AccessibilityXXXL 下的全宽换行；另检查无快照、仅约束无中心、低支持与陈旧心率。服务或私有配置异常时这些已启用的断言应失败，不能把“有测试跳过”记作 UI 验收通过。

四指标卡、图表顺序和负荷页面沿用现有实现。帮助使用卡下整行展开；辅助功能字号时四卡改为单列，文本完整换行。证据只读有界摘要，即使来源活动不可访问也不额外请求详情，不让整页因此失败。

走查完成删除 app 私有配置、停止并删除自有 Simulator；不要关闭共享测试服务或其它设备。只有合成 fixture 画面可放进公开 `docs/walkthrough/devops-990/`；真实用户资料与完整 xcresult 保持私有。
