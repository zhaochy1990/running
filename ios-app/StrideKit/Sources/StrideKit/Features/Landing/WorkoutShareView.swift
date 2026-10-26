import SwiftUI

/// 训练课表免登录分享落地页（PR-7 收尾域，规格 #758 拍板 2 / devops#703）：
/// V1 沉浸课卡（hero 课名+日期+三 stat → summary 左边线引用 → 全量分段）+
/// 双 CTA（保存到我的课表 ±7 天选日 / 推送手表先存后推+绑表检查续推）；
//  缺参/404 →「该分享已失效」；5xx 可重试。未登录 CTA → login?redirect=本页。
public struct WorkoutShareView: View {

    @Environment(AppModel.self) private var model
    @State private var share: WorkoutShareModel

    public init(user: String, workout: String) {
        _share = State(initialValue: WorkoutShareModel(user: user, workout: workout))
    }

    public var body: some View {
        let theme = model.theme.current
        ScrollView {
            switch share.loadState {
            case .loading:
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(theme.space(.xl))
            case .dead:
                deadCard("该分享已失效", theme: theme)
            case .error:
                VStack(spacing: theme.space(.md)) {
                    deadCard("加载失败，请稍后重试", theme: theme)
                    Button("重试") {
                        Task { await share.load() }
                    }
                    .font(theme.font(.fs14, weight: .medium))
                    .foregroundStyle(theme.accentDeep)
                }
            case .ready:
                readyCard(theme)
            }
        }
        .background(theme.background)
        .navigationTitle("课表分享")
        .inlineNavigationTitle()
        .raceToast(share.toastMessage) { share.toastMessage = nil }
        .task { await share.activate(app: model) }
        .onAppear { Task { await share.resumeIfNeeded() } }
        .sheet(isPresented: Binding(
            get: { share.sheetVisible },
            set: { if !$0 { share.closeSheet() } }
        )) {
            dateSheet(theme)
                .presentationDetents([.medium])
        }
        .alert("推送手表需先绑定", isPresented: Binding(
            get: { share.needsWatchBinding },
            set: { if !$0 { share.needsWatchBinding = false } }
        )) {
            Button("去绑定") { share.confirmGoBindWatch() }
            Button("暂不", role: .cancel) { share.needsWatchBinding = false }
        } message: {
            Text("绑定手表后即可推送课表到表盘")
        }
    }

    private func deadCard(_ text: String, theme: any Theme) -> some View {
        VStack(spacing: theme.space(.md)) {
            Image(systemName: "link.badge.plus")
                .font(theme.font(.fsDisplay40))
                .foregroundStyle(theme.mutedTwo)
            Text(text)
                .font(theme.font(.fs15))
                .foregroundStyle(theme.muted)
        }
        .frame(maxWidth: .infinity)
        .padding(theme.space(.xl))
    }

    // MARK: - 沉浸课卡

    private func readyCard(_ theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.lg)) {
            // hero
            VStack(alignment: .leading, spacing: theme.space(.sm)) {
                HStack(spacing: theme.space(.sm)) {
                    Image(systemName: share.runGroups.isEmpty ? "dumbbell.fill" : "figure.run")
                        .font(theme.font(.fs18))
                        .foregroundStyle(theme.accent)
                    if !share.dateLabel.isEmpty {
                        Text(share.dateLabel)
                            .font(theme.font(.fs12))
                            .foregroundStyle(theme.muted)
                            .padding(.horizontal, theme.space(.sm))
                            .padding(.vertical, 3)
                            .background(Capsule().strokeBorder(theme.border))
                    }
                }
                Text(share.name)
                    .font(theme.font(.fs22, weight: .bold))
                    .foregroundStyle(theme.foreground)
                if !share.summary.isEmpty {
                    Text(share.summary)
                        .font(theme.font(.fs13))
                        .foregroundStyle(theme.muted)
                        .padding(.leading, theme.space(.md))
                        .overlay(alignment: .leading) {
                            Rectangle().fill(theme.accent).frame(width: 3)
                        }
                }
            }

            // 三 stat
            HStack(spacing: theme.space(.md)) {
                ForEach(share.stats) { stat in
                    VStack(spacing: 4) {
                        Text(stat.value)
                            .font(theme.font(.fs18, weight: .bold))
                            .foregroundStyle(theme.foreground)
                        Text(stat.label)
                            .font(theme.font(.fs12))
                            .foregroundStyle(theme.muted)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, theme.space(.md))
                    .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(theme.surface))
                }
            }

            // 全量分段（所见即所得；跑课分段组 / 力量动作行）
            if !share.runGroups.isEmpty {
                VStack(alignment: .leading, spacing: theme.space(.md)) {
                    ForEach(share.runGroups) { group in
                        VStack(alignment: .leading, spacing: theme.space(.xs)) {
                            if group.repeatCount > 1 {
                                Text("× \(group.repeatCount)")
                                    .font(theme.font(.fs12, weight: .bold))
                                    .foregroundStyle(theme.accentDeep)
                            }
                            ForEach(group.rows) { row in
                                segmentRow(row, theme: theme)
                            }
                        }
                        .padding(.vertical, theme.space(.xs))
                    }
                    if !share.specNote.isEmpty {
                        Text(share.specNote)
                            .font(theme.font(.fs13))
                            .foregroundStyle(theme.muted)
                            .padding(theme.space(.md))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(theme.surface))
                    }
                }
            }
            if !share.exercises.isEmpty {
                VStack(alignment: .leading, spacing: theme.space(.xs)) {
                    ForEach(share.exercises) { exercise in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(exercise.name)
                                    .font(theme.font(.fs14, weight: .medium))
                                    .foregroundStyle(theme.foreground)
                                Spacer()
                                Text(exercise.target)
                                    .font(theme.font(.fs13))
                                    .foregroundStyle(theme.muted)
                            }
                            if !exercise.rest.isEmpty {
                                Text(exercise.rest)
                                    .font(theme.font(.fs12))
                                    .foregroundStyle(theme.mutedTwo)
                            }
                        }
                        .padding(.vertical, theme.space(.xs))
                    }
                }
            }

            // 双 CTA（#693 amendment：并排主次）
            HStack(spacing: theme.space(.md)) {
                Button {
                    share.saveTap()
                } label: {
                    HStack(spacing: theme.space(.xs)) {
                        if share.saving { ProgressView().tint(theme.onAccent).controlSize(.small) }
                        Image(systemName: share.saved ? "checkmark.circle.fill" : "square.and.arrow.down")
                        Text(share.saved ? "已保存" : "保存到我的课表")
                    }
                    .font(theme.font(.fs14, weight: .medium))
                    .foregroundStyle(theme.onAccent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, theme.space(.md))
                    .background(RoundedRectangle(cornerRadius: theme.radius(.md)).fill(theme.accent))
                }
                .buttonStyle(.plain)
                .disabled(share.saving || share.saved)

                Button {
                    share.pushTap()
                } label: {
                    HStack(spacing: theme.space(.xs)) {
                        Image(systemName: "applewatch")
                        Text(share.pushed ? "已推送" : "推送手表")
                    }
                    .font(theme.font(.fs14, weight: .medium))
                    .foregroundStyle(theme.accentDeep)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, theme.space(.md))
                    .background(RoundedRectangle(cornerRadius: theme.radius(.md)).strokeBorder(theme.accent))
                }
                .buttonStyle(.plain)
                .disabled(share.saving)
            }
            .padding(.top, theme.space(.sm))
        }
        .padding(theme.space(.lg))
    }

    private func segmentRow(_ row: LandingSegmentRow, theme: any Theme) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: theme.space(.sm)) {
            Text(row.kindLabel)
                .font(theme.font(.fs11, weight: .medium))
                .foregroundStyle(row.quiet ? theme.mutedTwo : stepColor(row.kindColorName))
                .padding(.horizontal, theme.space(.sm))
                .padding(.vertical, 2)
                .background(
                    Capsule().strokeBorder(row.quiet ? theme.borderSoft : stepColor(row.kindColorName).opacity(0.5))
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(row.main)
                    .font(theme.font(.fs14))
                    .foregroundStyle(row.quiet ? theme.muted : theme.foreground)
                if !row.hrCapText.isEmpty || !row.note.isEmpty {
                    Text([row.hrCapText, row.note].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(theme.font(.fs12))
                        .foregroundStyle(theme.mutedTwo)
                }
            }
            Spacer()
        }
    }

    private func stepColor(_ name: String) -> Color {
        switch name {
        case "green": .green
        case "pink": model.theme.current.accent
        case "blue": .blue
        case "purple": .purple
        default: .gray
        }
    }

    // MARK: - ±7 天选日 sheet（push-date-sheet 对等）

    private func dateSheet(_ theme: any Theme) -> some View {
        VStack(alignment: .leading, spacing: theme.space(.md)) {
            Text(share.sheetTitle)
                .font(theme.font(.fs15, weight: .medium))
                .foregroundStyle(theme.foreground)
                .padding(.top, theme.space(.lg))
            ScrollView {
                VStack(spacing: theme.space(.xs)) {
                    ForEach(share.sheetOptions) { option in
                        Button {
                            Task { await share.selectDate(option.value) }
                        } label: {
                            HStack {
                                Text(option.label)
                                    .font(theme.font(.fs14))
                                    .foregroundStyle(theme.foreground)
                                Spacer()
                                if option.selected {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(theme.accent)
                                }
                            }
                            .padding(theme.space(.md))
                            .background(RoundedRectangle(cornerRadius: theme.radius(.sm)).fill(option.selected ? theme.accent.opacity(0.08) : theme.surface))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(.horizontal, theme.space(.lg))
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
