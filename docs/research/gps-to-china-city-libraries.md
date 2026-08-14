# GPS 到中国城市/区县映射的 GitHub 方案调研

日期：2026-08-14

## 结论

Stride 目前只需按最近 30 天跑步次数统计用户常住城市，因此每个活动只需对一个代表性 GPS 点做一次逆地理编码，不应读取或发送整条轨迹。首选方案是接入一个可替换的 `ReverseGeocoder` 接口，并以在线 API 作为第一版实现。

如果第一版只需要省/市/区，推荐优先验证 [`codingsince1985/geo-golang`](https://github.com/codingsince1985/geo-golang) 的百度 provider：

- Go 原生、MIT、546 stars，最新 release 为 v1.9.0；README 声明同时支持百度和高德。
- 百度 provider 的实现直接支持 `wgs84ll` 输入，并把 `province`、`city`、`district` 映射到公共 `Address`。这与运动手表 GPS 的 WGS-84 数据和 Stride 的城市/区县需求直接匹配。百度响应中还有 `adcode`，但 `geo-golang` 的公共 `Address` 类型没有该字段，因此当前 provider 会丢弃它。
- 高德 provider 已存在，但当前通用 `geo.Address` 映射只把高德的 `district` 填入 `Suburb`，没有保留 `adcode`，也没有把返回结果的 city 映射到 `Address.City`；若选高德，直接写一个很小的内部 client 会比依赖该 provider 更清楚。
- `geo-golang` 的 `Geocoder` 接口不接收 `context.Context`，其 HTTP 实现固定使用内部 8 秒超时。若生产实现需要跟随 job 取消、保留 `adcode` 或注入统一 HTTP client，应直接封装百度官方 HTTP endpoint，而不是让第三方接口渗透到业务层。

若必须完全离线，建议把“空间查询引擎”和“中国行政区边界数据”分开：

- 数据采用 [`xiangyuecn/AreaCity-JsSpider-StatsGov`](https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov) 的三级省/市/区边界。项目 MIT、6.8k stars，2026-04-03 release 的 `ok_geo.csv.7z` 为 13 MB，解压约 130 MB，数据包含省市区并提供坐标系转换到 WGS-84。
- 查询层可用 [`SmilyOrg/tinygpkg`](https://github.com/SmilyOrg/tinygpkg)（MIT）读取预生成 GeoPackage。它的 README 报告约 12 ms 启动、约 27 MB 内存、单次查询约 63–87 微秒，但需要先把边界转为 GeoPackage/TWKB。
- 另一选择是用 [`paulmach/orb`](https://github.com/paulmach/orb) 解析 GeoJSON、用 quadtree 缩小候选、再做 point-in-polygon；这需要我们自己维护数据构建流程，不是开箱即用的逆地理编码库。

## 不建议直接采用的候选

### `sams96/rgeo`

[`sams96/rgeo`](https://github.com/sams96/rgeo) 是 Apache-2.0 的 Go 离线库，内置 Natural Earth 数据，README 声称城市级查询快于 800 ns/op、仓库约 32 MB。但 README 同时明确“not being actively developed”，并且 Natural Earth 的城市多边形过于粗糙。

本地用 v1.3.0 验证：上海、昆明、重庆市中心能返回预期城市；但苏州市中心错误返回 `Shanghai, Jiangsu`，崇明只返回上海省级，重庆万州返回旧名 `Wanxian`，舟山市中心只返回浙江省级。因此不适合作为 race detection 的异地城市信号来源。

### `KawaiiSh1zuku/ReGeocodeCN`

[`KawaiiSh1zuku/ReGeocodeCN`](https://github.com/KawaiiSh1zuku/ReGeocodeCN) 是 Go 写的中国离线逆地理编码服务，支持 WGS-84/GCJ-02/BD-09 和省/市/区输出，方向正确。但仓库在 2026-07-20 仅有一次提交、0 stars、没有许可证，并依赖另一个项目准备 `geodata` 和 Geonames 数据。当前不能直接作为生产依赖；可参考接口和分层方式。

### `xiangyuecn/AreaCity-Query-Geometry`

[`xiangyuecn/AreaCity-Query-Geometry`](https://github.com/xiangyuecn/AreaCity-Query-Geometry) 是 MIT、220 stars 的成熟高性能实现，支持省市区 point-in-polygon，README 给出的省市区数据为 176 MB、低内存模式约 41 MB、单核约 887 QPS。但它是 Java/JTS 服务，不是 Go 库；为一个 Go worker 新增 JVM sidecar 不划算。它更适合作为离线实现的行为和性能参考。

### 公共 Nominatim

`geo-golang` 也支持 OpenStreetMap Nominatim，但公共实例受 usage policy 约束，批量或周期性后台作业不应直接依赖公共端点。除非自行部署 Nominatim，否则不作为默认生产方案。

## 坐标系注意事项

- 手表 GPS 数据通常为 WGS-84。
- `AreaCity-JsSpider-StatsGov` 发布的原始边界是高德 GCJ-02；必须在构建数据包时一次性转换为 WGS-84，不能把 WGS-84 点直接查 GCJ-02 多边形。项目提供的转换工具明确支持导出 WGS-84。
- `geo-golang/baidu` 支持将请求的 `coordtype` 设为 `wgs84ll`，避免应用自行转换。

## 建议的 Stride 接口

```go
type AdministrativeLocation struct {
    Province string
    City     string
    District string
    Adcode   string
}

type ReverseGeocoder interface {
    ReverseGeocode(ctx context.Context, latitude, longitude float64) (AdministrativeLocation, error)
}
```

生产第一版只对每个最近 30 天的跑步活动取第一个有效 GPS 点，请求一次，按 `City` 统计唯一众数；同一 GPS 网格或坐标可缓存结果。race detection 候选也只需解析一个代表性点。这样复杂度与最近一个月活动数成正比，而不是与数百万 timeseries 点成正比。业务代码只依赖上面的内部接口：可以先用百度在线实现验证，再在需要规避第三方 GPS 传输、API 成本或网络失败时替换为 `tinygpkg` 离线实现。

为避免 provider 返回结构差异影响常住地，持久化时应同时保存规范化城市名和稳定行政区 code；直辖市需统一为北京、上海、天津、重庆的城市语义。

## 主要来源

- [`geo-golang` README](https://github.com/codingsince1985/geo-golang/blob/master/README.md)
- [`geo-golang` 百度实现](https://github.com/codingsince1985/geo-golang/blob/master/baidu/baidu.go)
- [`geo-golang` 高德实现](https://github.com/codingsince1985/geo-golang/blob/master/amap/amap.go)
- [`rgeo` README](https://github.com/sams96/rgeo/blob/main/README.md)
- [`tinygpkg` README](https://github.com/SmilyOrg/tinygpkg/blob/main/README.md)
- [`AreaCity-JsSpider-StatsGov` README](https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov/blob/master/README.md)
- [`AreaCity-Query-Geometry` README](https://github.com/xiangyuecn/AreaCity-Query-Geometry/blob/main/README.md)
- [`ReGeocodeCN` README](https://github.com/KawaiiSh1zuku/ReGeocodeCN/blob/main/README.md)
