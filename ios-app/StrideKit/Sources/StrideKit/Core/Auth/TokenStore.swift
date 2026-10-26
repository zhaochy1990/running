import Foundation
import Security

/// 双 token 存取（devops#749 §7.1：token 进 Keychain，devops#764 票面：
/// AfterFirstUnlockThisDeviceOnly）。
public protocol TokenStore: Sendable {
    func accessToken() async -> String?
    func refreshToken() async -> String?
    /// access token 过期时间（服务端 expires_in 累加；仅提示性，
    /// 会话有效性一律以服务端 401 为准，不信本地时间）。
    func expiresAt() async -> Date?
    func save(access: String, refresh: String, expiresIn: TimeInterval) async
    func clear() async
}

/// Keychain 实现：access / refresh / expiresAt 三条目，
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`（换机不迁移、
/// 锁屏后不可读的安全档）。
public struct KeychainTokenStore: TokenStore {

    private let service: String

    public init(service: String = "com.lipaotech.stridewise.auth") {
        self.service = service
    }

    public func accessToken() async -> String? { read("access_token") }
    public func refreshToken() async -> String? { read("refresh_token") }
    public func expiresAt() async -> Date? {
        guard let raw = read("expires_at") else { return nil }
        return TimeInterval(raw).map(Date.init(timeIntervalSince1970:))
    }

    public func save(access: String, refresh: String, expiresIn: TimeInterval) async {
        write("access_token", access)
        write("refresh_token", refresh)
        write("expires_at", String(Date().addingTimeInterval(expiresIn).timeIntervalSince1970))
    }

    public func clear() async {
        for account in ["access_token", "refresh_token", "expires_at"] {
            delete(account)
        }
    }

    // MARK: - SecItem 封装（同步、无共享可变状态，actor 内调用足够）

    private func read(_ account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func write(_ account: String, _ value: String) {
        let data = Data(value.utf8)
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = base.merging([
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]) { _, new in new }
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(base as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            SecItemAdd(attributes as CFDictionary, nil)
        }
    }

    private func delete(_ account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// 测试用内存实现。
public actor InMemoryTokenStore: TokenStore {
    private var access: String?
    private var refresh: String?
    private var expiry: Date?

    public init() {}

    public func accessToken() -> String? { access }
    public func refreshToken() -> String? { refresh }
    public func expiresAt() -> Date? { expiry }
    public func save(access: String, refresh: String, expiresIn: TimeInterval) async {
        self.access = access
        self.refresh = refresh
        self.expiry = Date().addingTimeInterval(expiresIn)
    }
    public func clear() async {
        access = nil
        refresh = nil
        expiry = nil
    }
}
