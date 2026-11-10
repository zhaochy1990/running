import Foundation
import Observation

// MARK: - 新增/编辑地址表单 ViewModel（devops#938，mp pages/address-form 直译；
// 字段 = #884 契约七项；编辑回填从列表里找本条——契约无单条 GET）
//
// 省市区 = 自建三级级联选择器（拍板 2：省→市→区逐级，数据 RegionPickerData
// 标准行政区划，不设区地级市区级回退市名=mp region picker 空第三列同款口径）。
// 前端校验：六项必填 + 手机 ^1\d{10}$；保存成功 toast → 400ms 返回。

@MainActor
@Observable
public final class AddressFormModel {

    public struct Form: Equatable, Sendable {
        public var name = ""
        public var phone = ""
        public var province = ""
        public var city = ""
        public var district = ""
        public var detail = ""
        public var isDefault = false
    }

    /// 编辑态（id>0）：标题「编辑地址」，进页回填。
    public let editing: Bool

    public private(set) var loading: Bool
    public private(set) var loadFailed = false
    public internal(set) var saving = false
    public internal(set) var form = Form()

    /// 级联选择器弹层。
    public internal(set) var pickerVisible = false

    /// toast 出口。
    public internal(set) var toastMessage: String?

    private let addressID: Int
    private var app: AppModel?
    private var loaded = false
    private var started = false
    private var dismissTask: Task<Void, Never>?

    public init(id: Int?) {
        addressID = id ?? 0
        editing = addressID > 0
        loading = editing
    }

    public func activate(app: AppModel) async {
        self.app = app
        guard !started else { return }
        started = true
        await app.waitUntilSessionSettled()
        if editing, !loaded {
            await load()
        }
    }

    /// 编辑态回填（契约无单条 GET，从列表里找本条；找不到=他端已删 → loadFailed）。
    public func load() async {
        guard let app else { return }
        loading = true
        loadFailed = false
        do {
            let res = try await app.api.listAddresses()
            guard let addr = res.addresses.first(where: { $0.id == addressID }) else {
                loading = false
                loadFailed = true
                return
            }
            loaded = true
            form = Form(
                name: addr.receiverName,
                phone: addr.receiverPhone,
                province: addr.province,
                city: addr.city,
                district: addr.district,
                detail: addr.addressDetail,
                isDefault: addr.isDefault
            )
            loading = false
        } catch {
            loading = false
            loadFailed = true
        }
    }

    // MARK: 校验（纯逻辑，供测试）

    /// 六项必填 + 手机 ^1\d{10}$；返回错误文案，nil = 通过（纯逻辑，nonisolated 供测试）。
    nonisolated public static func validate(_ form: Form) -> String? {
        if form.name.trimmingCharacters(in: .whitespaces).isEmpty
            || form.phone.trimmingCharacters(in: .whitespaces).isEmpty
            || form.province.trimmingCharacters(in: .whitespaces).isEmpty
            || form.city.trimmingCharacters(in: .whitespaces).isEmpty
            || form.district.trimmingCharacters(in: .whitespaces).isEmpty
            || form.detail.trimmingCharacters(in: .whitespaces).isEmpty {
            return "请填写完整的收货信息"
        }
        // 手机号先本地把关（后端 422 文案不友好）。
        let phone = form.phone.trimmingCharacters(in: .whitespaces)
        if phone.count != 11 || !phone.hasPrefix("1") || phone.dropFirst().contains(where: { !$0.isNumber }) {
            return "请输入正确的手机号"
        }
        return nil
    }

    // MARK: 保存

    public func save() async {
        guard !saving else { return }
        if let message = Self.validate(form) {
            toastMessage = message
            return
        }
        guard let app else { return }
        saving = true
        let payload = AddressPayload(
            receiverName: form.name.trimmingCharacters(in: .whitespaces),
            receiverPhone: form.phone.trimmingCharacters(in: .whitespaces),
            province: form.province.trimmingCharacters(in: .whitespaces),
            city: form.city.trimmingCharacters(in: .whitespaces),
            district: form.district.trimmingCharacters(in: .whitespaces),
            addressDetail: form.detail.trimmingCharacters(in: .whitespaces),
            isDefault: form.isDefault
        )
        do {
            if editing {
                _ = try await app.api.updateAddress(id: addressID, payload)
            } else {
                _ = try await app.api.createAddress(payload)
            }
            toastMessage = "已保存"
            // 400ms 后返回（mp setTimeout 同款节奏，让 toast 可见）。
            dismissTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(400))
                guard !Task.isCancelled else { return }
                self?.app?.router.pop()
            }
        } catch {
            saving = false
            toastMessage = pointsErrorCopy(error, "保存失败，请稍后再试")
        }
    }

    /// 页面离开时取消挂起的返回（防误 pop 别的页面）。
    public func cancelDismiss() {
        dismissTask?.cancel()
        dismissTask = nil
    }

    // MARK: 级联选择器

    public func showPicker() { pickerVisible = true }

    public func applyRegion(province: String, city: String, district: String) {
        form.province = province
        form.city = city
        // 不设区地级市（东莞/中山等）区级空 → 回退用市名填充保证契约必填。
        form.district = district.isEmpty ? city : district
        pickerVisible = false
    }

    /// 当前地区展示文案。
    public var regionText: String {
        [form.province, form.city, form.district].filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}
