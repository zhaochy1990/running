import Foundation

// MARK: - 省市区三级级联选择器数据逻辑（devops#938 拍板 2）
//
// 数据源 = 内嵌标准行政区划三级树（RegionTree，与微信 region picker / 后端
// 运费匹配同源口径）。选择器省→市→区逐级收窄（一次性组件，后续地址场景
// 复用）；不设区地级市（东莞/中山等）区级列表回退 [市名]（mp region picker
// 空第三列回退填市名同款口径）。

/// 级联选择器数据面：三级树 + 逐级取子集。
public enum RegionPickerData {

    /// 惰性解码一次（31 省级 / 三千余县级，纯数据无日期）。
    private static let tree: [String: [String: [String]]] = {
        guard let data = RegionTree.json.data(using: .utf8),
              let decoded = try? JSONDecoder().decode([String: [String: [String]]].self, from: data) else {
            return [:]
        }
        return decoded
    }()

    /// 省级列表（行政区划惯用序：华北/东北/华东/中南/西南/西北大致由北往南；
    /// 字典序稳定输出即可，picker 列表不做大区分组——mp region picker 同款平铺）。
    public static var provinces: [String] {
        tree.keys.sorted()
    }

    /// 指定省的市列表；未知省回空。
    public static func cities(province: String) -> [String] {
        (tree[province] ?? [:]).keys.sorted()
    }

    /// 指定省市的区县列表；不设区地级市（区级空）回退 [市]；未知省市回空。
    public static func districts(province: String, city: String) -> [String] {
        guard let list = tree[province]?[city] else { return [] }
        return list.isEmpty ? [city] : list
    }
}
