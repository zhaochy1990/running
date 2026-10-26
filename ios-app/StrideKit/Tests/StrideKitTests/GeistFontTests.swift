import CoreText
import Foundation
import Testing
@testable import StrideKit

/// Geist 字体注册与取用（验收相关：主题骨架可用性）。
@Suite struct GeistFontTests {

    @Test func registersAllSixFaces() {
        GeistFonts.registerIfNeeded()
        for name in ["Geist-Regular", "Geist-Medium", "Geist-Bold",
                     "GeistMono-Regular", "GeistMono-Medium", "GeistMono-Bold"] {
            // CTFont 找不到名字时会静默回退系统字体，故比对 PostScript 名防假绿
            let font = CTFontCreateWithName(name as CFString, 14, nil)
            let resolved = CTFontCopyPostScriptName(font) as String
            #expect(resolved == name, "字体未注册或名称不符：\(name) → \(resolved)")
        }
    }

    @Test func fixedFontSizeIgnoresDynamicType() {
        // 锁固定字号：.custom(size:) 本身不随 Dynamic Type 缩放（#753 决议 5）
        // 这里只保证取用路径不崩、三字重+等宽可构造。
        _ = GeistFonts.font(size: 15)
        _ = GeistFonts.font(size: 15, weight: .medium)
        _ = GeistFonts.font(size: 22, weight: .bold, mono: true)
    }
}

/// Keychain 双 token 存取（macOS 宿主跑真实 SecItem 往返）。
@Suite struct KeychainTokenStoreTests {

    @Test func roundTripsAndClears() async throws {
        // service 加随机后缀，避免与真实 App 会话/其他测试互相污染
        let store = KeychainTokenStore(service: "test.\(UUID().uuidString)")

        #expect(await store.accessToken() == nil)

        await store.save(access: "acc", refresh: "ref", expiresIn: 900)
        #expect(await store.accessToken() == "acc")
        #expect(await store.refreshToken() == "ref")
        let expiresAt = try #require(await store.expiresAt())
        #expect(expiresAt.timeIntervalSinceNow > 890 && expiresAt.timeIntervalSinceNow <= 900)

        await store.clear()
        #expect(await store.accessToken() == nil)
        #expect(await store.refreshToken() == nil)
        #expect(await store.expiresAt() == nil)
    }

    @Test func saveOverwritesExistingValues() async throws {
        let store = KeychainTokenStore(service: "test.\(UUID().uuidString)")
        await store.save(access: "a1", refresh: "r1", expiresIn: 60)
        await store.save(access: "a2", refresh: "r2", expiresIn: 60)
        #expect(await store.accessToken() == "a2")
        #expect(await store.refreshToken() == "r2")
        await store.clear()
    }
}
