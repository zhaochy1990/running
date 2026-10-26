import CoreLocation
import MapKit
import SwiftUI

#if canImport(UIKit)
import UIKit

/// MKMapView 包装（devops#766，#754 决议一：iOS 17 基线下 MKMapView +
/// UIViewRepresentable，一次性成本换 MapKit 全能力开放）。
///
/// - 坐标：WGS-84 直传（TrackMapBuilder 已保证，勿在此转 GCJ-02；
///   MapKit 中国区自动加偏）
/// - 手势：isRotateEnabled / isPitchEnabled = false（对齐小程序 map 组件
///   默认），scroll / zoom 开放；standard 样式
/// - polyline 分段着色（着色切换全量重建 overlay 并重新 fit 视野，
///   与小程序 include-points 行为一致）
/// - 标注：起终点绿▶/红■（白底圆衬）、圈号徽标（RQ 风格深绿底）
struct TrackMapView: UIViewRepresentable {

    let map: TrackMapData
    let markers: [TrackMarker]

    func makeUIView(context: Context) -> MKMapView {
        let view = MKMapView()
        view.delegate = context.coordinator
        view.isRotateEnabled = false
        view.isPitchEnabled = false
        view.showsUserLocation = false
        view.mapType = .standard
        view.isAccessibilityElement = false
        return view
    }

    func updateUIView(_ view: MKMapView, context: Context) {
        let coordinator = context.coordinator

        if coordinator.drawnPolylines != map.polylines {
            view.removeOverlays(coordinator.overlays)
            let overlays = map.polylines.map(ColoredPolyline.init(track:))
            view.addOverlays(overlays)
            coordinator.overlays = overlays
            coordinator.drawnPolylines = map.polylines

            // 含 10% padding 的视野（着色切换重新 fit，对齐 include-points）。
            let spanLat = TrackMapView.meters(fromDelta: map.fitNorthEast.latitude - map.fitSouthWest.latitude)
            let spanLng = TrackMapView.meters(
                fromDelta: map.fitNorthEast.longitude - map.fitSouthWest.longitude,
                scaledBy: cos(map.center.latitude * .pi / 180)
            )
            view.setRegion(
                MKCoordinateRegion(
                    center: map.center,
                    latitudinalMeters: max(spanLat, 50),
                    longitudinalMeters: max(spanLng, 50)
                ),
                animated: false
            )
        }

        if coordinator.markers != markers {
            view.removeAnnotations(coordinator.annotations)
            let annotations = markers.map(TrackAnnotation.init(marker:))
            view.addAnnotations(annotations)
            coordinator.annotations = annotations
            coordinator.markers = markers
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    /// 纬度差 → 米（1° ≈ 111.32km；经度再乘 cos(lat) 缩放）。
    private static func meters(fromDelta degrees: Double, scaledBy factor: Double = 1) -> Double {
        degrees * 111_320 * factor
    }

    final class Coordinator: NSObject, MKMapViewDelegate {
        var overlays: [ColoredPolyline] = []
        var drawnPolylines: [TrackPolyline] = []
        var annotations: [TrackAnnotation] = []
        var markers: [TrackMarker] = []

        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            guard let track = overlay as? ColoredPolyline else {
                return MKOverlayRenderer(overlay: overlay)
            }
            let renderer = MKPolylineRenderer(polyline: track)
            renderer.strokeColor = track.uiColor
            renderer.lineWidth = track.width
            return renderer
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            guard let track = annotation as? TrackAnnotation else { return nil }
            // 标注量级 ≤ 圈数 + 2，直接新建不复用，杜绝复用视图叠子视图。
            let view = MKAnnotationView(annotation: annotation, reuseIdentifier: nil)
            view.canShowCallout = false
            view.frame.size = CGSize(width: 18, height: 18)
            view.addSubview(TrackMarkerBadge(kind: track.kind, frame: view.bounds))
            return view
        }
    }
}

/// 带颜色的 polyline（MKPolyline 不携带渲染属性，子类挂 color/width）。
final class ColoredPolyline: MKPolyline {
    var uiColor: UIColor = .systemGreen
    var width: CGFloat = mapLineWidth

    convenience init(track: TrackPolyline) {
        let coords = track.points
        self.init(coordinates: coords, count: coords.count)
        self.uiColor = UIColor(Tokens.color(track.color))
        self.width = CGFloat(track.width)
    }
}

/// 轨迹标注（起终点 / 圈号徽标）。
final class TrackAnnotation: NSObject, MKAnnotation {
    let marker: TrackMarker
    var coordinate: CLLocationCoordinate2D { marker.coordinate }
    var kind: TrackMarker.Kind { marker.kind }

    init(marker: TrackMarker) {
        self.marker = marker
    }
}

/// 标注视图（frame 布局静态小件）：
/// - 起点 ▶ 绿 / 终点 ■ 红（白底圆衬 + 轻投影，18pt 对齐小程序 marker 尺寸）
/// - 圈号徽标：深绿底 #0b3d24 + STRIDE 绿描边 #00e676 + 白字（RQ 风格）
private final class TrackMarkerBadge: UIView {

    init(kind: TrackMarker.Kind, frame: CGRect) {
        super.init(frame: frame)

        let container = UIView(frame: bounds)
        container.translatesAutoresizingMaskIntoConstraints = true
        addSubview(container)

        switch kind {
        case .start, .end:
            container.backgroundColor = .white
            container.layer.cornerRadius = frame.width / 2
            container.layer.shadowColor = UIColor.black.withAlphaComponent(0.25).cgColor
            container.layer.shadowOpacity = 1
            container.layer.shadowRadius = 2
            container.layer.shadowOffset = CGSize(width: 0, height: 1)
            let icon = UIImageView(image: UIImage(systemName: kind == .start ? "play.fill" : "stop.fill"))
            icon.tintColor = kind == .start ? UIColor(Tokens.color(mapGreen)) : UIColor(Tokens.color(mapRed))
            icon.contentMode = .center
            icon.frame = bounds.insetBy(dx: 4.5, dy: 4.5)
            container.addSubview(icon)
        case .lapBadge(let number):
            container.backgroundColor = UIColor(red: 0x0B / 255, green: 0x3D / 255, blue: 0x24 / 255, alpha: 1)
            container.layer.borderColor = UIColor(Tokens.color(0x00E676)).cgColor
            container.layer.borderWidth = 1
            container.layer.cornerRadius = frame.width / 2
            let label = UILabel(frame: bounds)
            label.text = String(number)
            label.font = .systemFont(ofSize: 8, weight: .semibold)
            label.textColor = .white
            label.textAlignment = .center
            container.addSubview(label)
        }
    }

    required init?(coder: NSCoder) {
        fatalError("TrackMarkerBadge 不走 storyboard")
    }
}

#else

/// macOS 宿主（swift test）占位：MKMapView / UIViewRepresentable 仅 iOS；
/// 地图数据构建在 TrackMapBuilder（纯函数）有单测覆盖。
struct TrackMapView: View {
    let map: TrackMapData
    let markers: [TrackMarker]

    var body: some View {
        ZStack {
            Rectangle().fill(Color.gray.opacity(0.12))
            Image(systemName: "map")
                .foregroundStyle(.secondary)
        }
    }
}

#endif
