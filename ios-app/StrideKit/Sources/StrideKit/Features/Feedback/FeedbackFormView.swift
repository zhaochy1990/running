import SwiftUI
import PhotosUI

/// 提交反馈全屏表单（devops#554 原型 518 variant C）：类型分段联动占位 →
/// 描述 textarea（必填点亮提交）→ 图片四列格（PhotosPicker 0-9 张、
/// >10MB 跳过 toast、点缩略图全屏查看、删除角标）→ 提交（两段式）。
/// 成功 toast 后自动返回上一页。
public struct FeedbackFormView: View {

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var form = FeedbackFormModel()

    @State private var picking = false
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var previewIndex: Int?

    public init() {}

    public var body: some View {
        let theme = model.theme.current
        ScrollView {
            VStack(alignment: .leading, spacing: theme.space(.lg)) {
                typeSegment(theme)
                TextEditor(text: $form.content)
                    .font(theme.font(.fs15))
                    .foregroundStyle(theme.foreground)
                    .frame(minHeight: 120)
                    .scrollContentBackground(.hidden)
                    .padding(theme.space(.md))
                    .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(theme.surface))
                    .overlay(alignment: .topLeading) {
                        if form.content.isEmpty {
                            Text(form.placeholder)
                                .font(theme.font(.fs15))
                                .foregroundStyle(theme.mutedTwo)
                                .padding(theme.space(.lg))
                                .allowsHitTesting(false)
                        }
                    }

                picGrid(theme)

                Button {
                    Task {
                        await form.submit()
                        if form.submitted {
                            try? await Task.sleep(for: .milliseconds(600))
                            dismiss()
                        }
                    }
                } label: {
                    HStack(spacing: theme.space(.sm)) {
                        if form.submitting { ProgressView().tint(theme.onAccent) }
                        Text("提交")
                            .font(theme.font(.fs15, weight: .medium))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, theme.space(.md))
                    .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(form.canSubmit ? theme.accent : theme.mutedTwo))
                    .foregroundStyle(theme.onAccent)
                }
                .buttonStyle(.plain)
                .disabled(!form.canSubmit)
            }
            .padding(theme.space(.lg))
        }
        .background(theme.background)
        .navigationTitle("提交反馈")
        .inlineNavigationTitle()
        .raceToast(form.toastMessage) { form.toastMessage = nil }
        .task { await form.activate(app: model) }
        .onChange(of: pickerItems) { _, items in
            let picked = items
            pickerItems = []
            guard !picked.isEmpty else { return }
            Task {
                var payloads: [Data] = []
                for item in picked {
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        payloads.append(data)
                    }
                }
                await form.addPics(payloads)
            }
        }
        .platformFullScreen(isPresented: Binding(
            get: { previewIndex != nil },
            set: { if !$0 { previewIndex = nil } }
        )) {
            if let index = previewIndex {
                PicViewer(pics: form.pics, index: index)
            }
        }
    }

    private struct PicIndex: Identifiable {
        let index: Int
        var id: Int { index }
    }

    // MARK: - 类型分段

    private func typeSegment(_ theme: any Theme) -> some View {
        HStack(spacing: 0) {
            ForEach(FeedbackFormModel.typeDefs, id: \.type) { def in
                typeButton(def.type, label: def.label, theme: theme)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: theme.radius(.md))
                .fill(theme.surface)
                .overlay(RoundedRectangle(cornerRadius: theme.radius(.md)).strokeBorder(theme.border))
        )
    }

    private func typeButton(_ type: FeedbackType, label: String, theme: any Theme) -> some View {
        let selected = form.type == type
        return Button {
            form.switchType(type)
        } label: {
            Text(label)
                .font(theme.font(.fs14, weight: selected ? .medium : .regular))
                .foregroundStyle(selected ? theme.onAccent : theme.muted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, theme.space(.md))
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: theme.radius(.md))
                .fill(selected ? theme.accent : Color.clear)
        )
    }

    // MARK: - 图片四列格

    private func picGrid(_ theme: any Theme) -> some View {
        let columns = Array(repeating: GridItem(.flexible(), spacing: theme.space(.sm)), count: 4)
        return LazyVGrid(columns: columns, spacing: theme.space(.sm)) {
            ForEach(Array(form.pics.enumerated()), id: \.element.id) { index, pic in
                ZStack(alignment: .topTrailing) {
                    PicThumb(data: pic.data)
                        .frame(height: 76)
                        .clipShape(RoundedRectangle(cornerRadius: theme.radius(.sm)))
                        .onTapGesture { previewIndex = index }
                    Button {
                        form.deletePic(at: pic.id)
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(theme.font(.fs14))
                            .foregroundStyle(theme.danger)
                            .background(Circle().fill(theme.background))
                    }
                    .buttonStyle(.plain)
                    .padding(4)
                }
            }
            if form.pics.count < feedbackMaxImages {
                PhotosPicker(selection: $pickerItems, maxSelectionCount: feedbackMaxImages - form.pics.count, matching: .images) {
                    VStack(spacing: theme.space(.xs)) {
                        Image(systemName: "plus")
                            .font(theme.font(.fs18))
                            .foregroundStyle(theme.mutedTwo)
                        Text("\(form.pics.count)/9")
                            .font(theme.font(.fs12))
                            .foregroundStyle(theme.mutedTwo)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 76)
                    .background(RoundedRectangle(cornerRadius: theme.radius(.sm)).fill(theme.surface))
                    .overlay(RoundedRectangle(cornerRadius: theme.radius(.sm)).strokeBorder(theme.borderSoft, style: StrokeStyle(dash: [4])))
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// 缩略图（Data → 平台 Image，加载失败回落占位色块）。
struct PicThumb: View {
    let data: Data

    var body: some View {
        Group {
            if let image = PlatformImage.image(data: data) {
                image.resizable().scaledToFill()
            } else {
                Color.clear
            }
        }
        .frame(maxWidth: .infinity)
    }
}

/// 全屏查看器（previewImage 的 D-9 对等：显式交互，无长按保存）。
private struct PicViewer: View {

    let pics: [FeedbackFormModel.Pic]
    let index: Int
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TabView(selection: .constant(index)) {
                ForEach(Array(pics.enumerated()), id: \.element.id) { _, pic in
                    Group {
                        if let image = PlatformImage.image(data: pic.data) {
                            image.resizable().scaledToFit()
                        } else {
                            Color.clear
                        }
                    }
                    .tag(index)
                }
            }
            .pageTabStyleCompat()
            .background(Color.black)
            .toolbar {
                ToolbarItem(placement: .navigation) {
                    Button("关闭") { dismiss() }
                        .foregroundStyle(.white)
                }
            }
        }
    }
}
