import Foundation
import RealityKit
import simd
import UIKit

/// A binary glTF 2.0 file (GLB), read into RealityKit entities. The Link packs every glTF into
/// one GLB when it is imported, so this reads only that form: its node tree (names and
/// transforms), triangle meshes with positions, normals and indices, and each material's base
/// color, metalness and roughness. Textures, skins and animation aren't read.
struct GLB {
    struct Primitive {
        var positions: [SIMD3<Float>]
        var normals: [SIMD3<Float>]
        var indices: [UInt32]
        var color: SIMD4<Float>
        var metallic: Float
        var roughness: Float
    }

    struct Node {
        var name: String?
        var transform: Transform
        var mesh: Int?
        var children: [Int]
    }

    enum Failure: Error, LocalizedError {
        case notGLB, broken(String)
        var errorDescription: String? {
            switch self {
            case .notGLB: "It isn't a glTF 2.0 binary (.glb)."
            case .broken(let why): "The model is broken: \(why)."
            }
        }
    }

    var nodes: [Node] = []
    var meshes: [[Primitive]] = []
    var roots: [Int] = []

    static func isGLB(_ d: Data) -> Bool { d.count >= 12 && d.prefix(4) == Data("glTF".utf8) }

    init(_ data: Data) throws {
        guard Self.isGLB(data) else { throw Failure.notGLB }
        let bytes = [UInt8](data)
        func u32(_ o: Int) -> Int { Int(bytes[o]) | Int(bytes[o + 1]) << 8 | Int(bytes[o + 2]) << 16 | Int(bytes[o + 3]) << 24 }
        var at = 12
        var json: [String: Any]?
        var bin: [UInt8] = []
        while at + 8 <= bytes.count {
            let len = u32(at), type = u32(at + 4)
            guard at + 8 + len <= bytes.count else { throw Failure.broken("a chunk runs past the end") }
            let body = Array(bytes[(at + 8) ..< (at + 8 + len)])
            if type == 0x4E4F_534A { json = try JSONSerialization.jsonObject(with: Data(body)) as? [String: Any] }
            if type == 0x004E_4942 { bin = body }
            at += 8 + len
        }
        guard let json else { throw Failure.broken("no JSON chunk") }
        let accessors = json["accessors"] as? [[String: Any]] ?? []
        let views = json["bufferViews"] as? [[String: Any]] ?? []
        let materials = json["materials"] as? [[String: Any]] ?? []

        func read(_ i: Int?) -> [[Float]] {
            guard let i, i < accessors.count else { return [] }
            let a = accessors[i]
            guard let vi = a["bufferView"] as? Int, vi < views.count else { return [] }
            let v = views[vi]
            let n = ["SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4][a["type"] as? String ?? ""] ?? 1
            let ct = a["componentType"] as? Int ?? 5126
            let size = [5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4][ct] ?? 4
            let stride = (v["byteStride"] as? Int) ?? n * size
            let start = (v["byteOffset"] as? Int ?? 0) + (a["byteOffset"] as? Int ?? 0)
            let count = a["count"] as? Int ?? 0
            guard count >= 0, start + max(0, count - 1) * stride + n * size <= bin.count else { return [] }
            func b32(_ o: Int) -> UInt32 { UInt32(bin[o]) | UInt32(bin[o + 1]) << 8 | UInt32(bin[o + 2]) << 16 | UInt32(bin[o + 3]) << 24 }
            var out: [[Float]] = []
            out.reserveCapacity(count)
            for k in 0 ..< count {
                var row: [Float] = []
                for c in 0 ..< n {
                    let o = start + k * stride + c * size
                    switch ct {
                    case 5126: row.append(Float(bitPattern: b32(o)))
                    case 5125: row.append(Float(b32(o)))
                    case 5123: row.append(Float(UInt16(bin[o]) | UInt16(bin[o + 1]) << 8))
                    case 5121: row.append(Float(bin[o]))
                    default: row.append(0)
                    }
                }
                out.append(row)
            }
            return out
        }

        for m in json["meshes"] as? [[String: Any]] ?? [] {
            var prims: [Primitive] = []
            for p in m["primitives"] as? [[String: Any]] ?? [] {
                guard (p["mode"] as? Int ?? 4) == 4, let attrs = p["attributes"] as? [String: Any] else { continue }
                let pos = read(attrs["POSITION"] as? Int).map { SIMD3<Float>($0[0], $0[1], $0[2]) }
                guard !pos.isEmpty else { continue }
                var idx = read(p["indices"] as? Int).map { UInt32($0[0]) }
                if idx.isEmpty { idx = (0 ..< UInt32(pos.count)).map { $0 } }
                idx = Array(idx.prefix(idx.count - idx.count % 3)).filter { Int($0) < pos.count }
                var nrm = read(attrs["NORMAL"] as? Int).map { SIMD3<Float>($0[0], $0[1], $0[2]) }
                if nrm.count != pos.count { nrm = Self.normals(pos, idx) }
                let mat = (p["material"] as? Int).flatMap { $0 < materials.count ? materials[$0] : nil }
                let pbr = mat?["pbrMetallicRoughness"] as? [String: Any]
                let f = (pbr?["baseColorFactor"] as? [Double]) ?? [0.75, 0.75, 0.78, 1]
                prims.append(Primitive(
                    positions: pos, normals: nrm, indices: idx,
                    color: SIMD4<Float>(f.count > 3 ? f.map(Float.init) : [0.75, 0.75, 0.78, 1]),
                    metallic: Float(pbr?["metallicFactor"] as? Double ?? 1),
                    roughness: Float(pbr?["roughnessFactor"] as? Double ?? 1)
                ))
            }
            meshes.append(prims)
        }
        for n in json["nodes"] as? [[String: Any]] ?? [] {
            var tr = Transform.identity
            if let m = n["matrix"] as? [Double], m.count == 16 {
                let f = m.map(Float.init)
                tr = Transform(matrix: float4x4(SIMD4(f[0], f[1], f[2], f[3]), SIMD4(f[4], f[5], f[6], f[7]), SIMD4(f[8], f[9], f[10], f[11]), SIMD4(f[12], f[13], f[14], f[15])))
            } else {
                let t = (n["translation"] as? [Double])?.map(Float.init) ?? [0, 0, 0]
                let r = (n["rotation"] as? [Double])?.map(Float.init) ?? [0, 0, 0, 1]
                let s = (n["scale"] as? [Double])?.map(Float.init) ?? [1, 1, 1]
                if t.count == 3, r.count == 4, s.count == 3 {
                    tr = Transform(scale: SIMD3(s[0], s[1], s[2]), rotation: simd_quatf(ix: r[0], iy: r[1], iz: r[2], r: r[3]), translation: SIMD3(t[0], t[1], t[2]))
                }
            }
            let name = (n["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            nodes.append(Node(name: name, transform: tr, mesh: n["mesh"] as? Int, children: (n["children"] as? [Int] ?? []).filter { $0 >= 0 }))
        }
        let scenes = json["scenes"] as? [[String: Any]] ?? []
        let si = json["scene"] as? Int ?? 0
        if si < scenes.count, let r = scenes[si]["nodes"] as? [Int] {
            roots = r.filter { $0 >= 0 && $0 < nodes.count }
        } else {
            let kids = Set(nodes.flatMap(\.children))
            roots = nodes.indices.filter { !kids.contains($0) }
        }
    }

    /// Smooth normals from the triangles, for meshes that come without them.
    static func normals(_ pos: [SIMD3<Float>], _ idx: [UInt32]) -> [SIMD3<Float>] {
        var n = [SIMD3<Float>](repeating: .zero, count: pos.count)
        for k in stride(from: 0, to: idx.count - 2, by: 3) {
            let a = Int(idx[k]), b = Int(idx[k + 1]), c = Int(idx[k + 2])
            let f = cross(pos[b] - pos[a], pos[c] - pos[a])
            n[a] += f; n[b] += f; n[c] += f
        }
        return n.map { length($0) > 0 ? normalize($0) : SIMD3(0, 1, 0) }
    }

    /// The model as entities: one per node, named as the node is, with each mesh primitive a
    /// nameless `ModelEntity` child. Also returns every mesh entity with its triangles, for picking.
    @MainActor
    func build() throws -> (root: Entity, meshes: [(ModelEntity, Primitive)]) {
        let root = Entity()
        var made: [(ModelEntity, Primitive)] = []
        var cache: [Int: [(MeshResource, Primitive)]] = [:]
        func meshes(_ i: Int) throws -> [(MeshResource, Primitive)] {
            if let c = cache[i] { return c }
            var out: [(MeshResource, Primitive)] = []
            for p in self.meshes[i] where !p.indices.isEmpty {
                var d = MeshDescriptor(name: "m\(i)")
                d.positions = MeshBuffers.Positions(p.positions)
                d.normals = MeshBuffers.Normals(p.normals)
                d.primitives = .triangles(p.indices)
                out.append((try MeshResource.generate(from: [d]), p))
            }
            cache[i] = out
            return out
        }
        func visit(_ i: Int, _ parent: Entity, _ depth: Int) throws {
            guard i < nodes.count, depth < 64 else { return }
            let n = nodes[i]
            let e = Entity()
            e.name = n.name ?? ""
            e.transform = n.transform
            parent.addChild(e)
            if let m = n.mesh, m < self.meshes.count {
                for (res, p) in try meshes(m) {
                    let me = ModelEntity(mesh: res, materials: [Self.material(p)])
                    e.addChild(me)
                    made.append((me, p))
                }
            }
            for c in n.children { try visit(c, e, depth + 1) }
        }
        for r in roots { try visit(r, root, 0) }
        return (root, made)
    }

    static func material(_ p: Primitive, highlight: UIColor? = nil) -> RealityKit.Material {
        var m = PhysicallyBasedMaterial()
        let c = p.color
        m.baseColor = .init(tint: highlight ?? UIColor(red: CGFloat(c.x), green: CGFloat(c.y), blue: CGFloat(c.z), alpha: 1))
        m.metallic = .init(floatLiteral: highlight == nil ? p.metallic : 0)
        m.roughness = .init(floatLiteral: p.roughness)
        if let highlight {
            m.emissiveColor = .init(color: highlight)
            m.emissiveIntensity = 0.35
        }
        return m
    }
}
