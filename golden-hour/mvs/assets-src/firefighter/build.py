"""
Firefighter asset v3: authored in Blender, exported as GLB.

Run from mvs/:
    blender --background --factory-startup --python assets-src/firefighter/build.py

Design goals (commercial-slice quality):
  * believable 7.5-head figure with heroic turnout-gear silhouette
  * layered garment construction (shell, collar, storm flap, pockets, trim)
  * continuous lofted limbs / torso instead of stacked primitives
  * procedural PBR texture set (fabric weave, leather grain, reflective tape)
  * smooth-ish deterministic skinning + hand-keyed Idle / Walk / Reach
"""

import math
import os
import shutil
import struct
import zlib

import addon_utils
import bmesh
import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(ROOT, "public", "assets", "firefighter.glb")
SHOT_DIR = os.path.join(HERE, "shots")
TEX_DIR = os.path.join(HERE, "tex")
PREVIEW = os.path.join(HERE, "preview.png")
for _d in (SHOT_DIR, TEX_DIR):
    os.makedirs(_d, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
SCENE = bpy.context.scene
SCENE.render.fps = 24
try:
    addon_utils.enable("io_scene_gltf2")
except Exception:
    pass

TAU = math.pi * 2.0
SIDES = (("L", -1.0), ("R", 1.0))

# ---------------------------------------------------------------------------
# palette (sRGB hex)
# ---------------------------------------------------------------------------

PALETTE = {
    "coat": ("#33544a", 0.86, 0.0, 0.72),
    "coat_dark": ("#243b33", 0.9, 0.0, 0.6),
    "trousers": ("#2a323a", 0.92, 0.0, 0.7),
    "trousers_dark": ("#1e252b", 0.94, 0.0, 0.6),
    "webbing": ("#303637", 0.86, 0.05, 0.55),
    "boot": ("#101418", 0.55, 0.02, 0.65),
    "sole": ("#0a0c0e", 0.95, 0.0, 0.45),
    "glove": ("#584733", 0.66, 0.0, 0.62),
    "leather": ("#5a4130", 0.6, 0.0, 0.6),
    "helmet": ("#c08a28", 0.38, 0.1, 0.35),
    "helmet_dark": ("#77561a", 0.46, 0.12, 0.35),
    "reflective": ("#c3cbcf", 0.3, 0.38, 0.3),
    "fluoro": ("#c2d247", 0.6, 0.0, 0.3),
    "rubber": ("#15191c", 0.9, 0.0, 0.5),
    "steel": ("#78818a", 0.32, 0.72, 0.4),
    "lens": ("#22333d", 0.16, 0.28, 0.18),
    "brass": ("#a98544", 0.34, 0.85, 0.35),
    "accent": ("#b8462c", 0.58, 0.0, 0.3),
    "nomex": ("#20272d", 0.95, 0.0, 0.5),
}

# kind drives the procedural surface pattern
TEXTURE_SPEC = {
    "coat": ("weave", 768, 0.5, 0.07),
    "coat_dark": ("weave", 768, 0.5, 0.07),
    "trousers": ("twill", 768, 0.55, 0.055),
    "trousers_dark": ("twill", 768, 0.55, 0.055),
    "webbing": ("weave", 512, 0.45, 0.06),
    "boot": ("leather", 512, 0.7, 0.08),
    "glove": ("leather", 512, 0.65, 0.07),
    "leather": ("leather", 512, 0.7, 0.07),
    "helmet": ("speckle", 512, 0.3, 0.045),
    "reflective": ("micro", 256, 0.9, 0.03),
    "rubber": ("rubber", 256, 0.4, 0.045),
    "steel": ("brushed", 256, 0.4, 0.03),
    "nomex": ("weave", 256, 0.4, 0.05),
}


# ---------------------------------------------------------------------------
# tiny PNG writer + procedural textures
# ---------------------------------------------------------------------------

def write_png(path, arr):
    h, w, c = arr.shape
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += arr[y].tobytes()
    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6 if c == 4 else 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


def fbm(size, seed, octaves=4, base=4):
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:size, 0:size]
    u = x / size
    v = y / size
    out = np.zeros((size, size), dtype=np.float64)
    amp = 1.0
    norm = 0.0
    for o in range(octaves):
        f = base * (2 ** o)
        for _ in range(3):
            fx = float(rng.integers(1, f + 1))
            fy = float(rng.integers(1, f + 1))
            ph = float(rng.uniform(0, TAU))
            out += amp * np.sin(TAU * (fx * u + fy * v) + ph)
            norm += amp
        amp *= 0.5
    return out / max(norm, 1e-6)


def surface_height(kind, size, seed):
    y, x = np.mgrid[0:size, 0:size]
    u = x / size
    v = y / size
    n = fbm(size, seed, 4, 4)
    fine = fbm(size, seed + 17, 3, 24)
    if kind == "weave":
        return 0.45 * n + 0.35 * np.sin(TAU * 108 * u) * np.sin(TAU * 108 * v) + 0.2 * fine
    if kind == "twill":
        return 0.5 * n + 0.35 * np.sin(TAU * (86 * u + 86 * v)) + 0.15 * fine
    if kind == "leather":
        return 0.65 * n + 0.35 * np.clip(np.abs(fine) * 2.2, 0, 1)
    if kind == "speckle":
        return 0.7 * n + 0.3 * np.abs(fine)
    if kind == "micro":
        return 0.55 * (np.sin(TAU * 120 * u) * np.sin(TAU * 120 * v)) + 0.45 * n
    if kind == "brushed":
        return 0.62 * np.sin(TAU * 140 * u) + 0.38 * n
    return n


def build_textures():
    for name, (kind, size, nstr, camp) in TEXTURE_SPEC.items():
        hex_color = PALETTE[name][0]
        if name not in PALETTE:
            continue
        base = np.array([int(hex_color[i : i + 2], 16) for i in (1, 3, 5)], dtype=np.float64) / 255.0
        seed = (zlib.crc32(name.encode("utf-8")) % 100000) + 7
        hgt = surface_height(kind, size, seed)
        blotch = fbm(size, seed + 91, 2, 2)
        col = base[None, None, :] * (1.0 + camp * blotch[..., None] + camp * 0.6 * hgt[..., None])
        col = np.clip(col, 0.0, 1.0)
        rgb = np.round(col * 255.0).astype(np.uint8)
        write_png(os.path.join(TEX_DIR, f"{name}_color.png"), rgb)

        gy, gx = np.gradient(hgt)
        nx = -gx * nstr * 2.2
        ny = -gy * nstr * 2.2
        nz = np.ones_like(nx)
        ln = np.sqrt(nx * nx + ny * ny + nz * nz)
        nrm = np.stack([nx / ln, ny / ln, nz / ln], -1) * 0.5 + 0.5
        write_png(os.path.join(TEX_DIR, f"{name}_normal.png"), np.round(nrm * 255).astype(np.uint8))


def srgb(hex_color):
    h = hex_color.lstrip("#")
    raw = [int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4)]
    def conv(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return tuple(conv(c) for c in raw) + (1.0,)


def make_material(name, hex_color, rough, metal, normal_strength=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = srgb(hex_color)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if normal_strength > 0.0:
        color_path = os.path.join(TEX_DIR, f"{name}_color.png")
        normal_path = os.path.join(TEX_DIR, f"{name}_normal.png")
        if os.path.exists(color_path):
            img = bpy.data.images.load(color_path, check_existing=True)
            img.colorspace_settings.name = "sRGB"
            tex = nt.nodes.new("ShaderNodeTexImage")
            tex.image = img
            tex.interpolation = "Linear"
            tex.location = (-560, 260)
            nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
            bsdf.inputs["Base Color"].default_value = (1, 1, 1, 1)
        if os.path.exists(normal_path):
            nimg = bpy.data.images.load(normal_path, check_existing=True)
            nimg.colorspace_settings.name = "Non-Color"
            ntex = nt.nodes.new("ShaderNodeTexImage")
            ntex.image = nimg
            ntex.interpolation = "Linear"
            ntex.location = (-560, -60)
            nmap = nt.nodes.new("ShaderNodeNormalMap")
            nmap.inputs["Strength"].default_value = 1.0
            nmap.location = (-260, -60)
            nt.links.new(ntex.outputs["Color"], nmap.inputs["Color"])
            nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


build_textures()
MAT = {}
for name, (hex_color, rough, metal, _unused) in PALETTE.items():
    spec = TEXTURE_SPEC.get(name)
    MAT[name] = make_material(name, hex_color, rough, metal, spec[2] if spec else 0.0)


# ---------------------------------------------------------------------------
# geometry helpers
# ---------------------------------------------------------------------------

PARTS = []


def link(obj):
    bpy.context.collection.objects.link(obj)
    return obj


def activate(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def recalc_normals(mesh):
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()


def shade(obj, smooth=True, angle=49.0):
    for poly in obj.data.polygons:
        poly.use_smooth = smooth
    if smooth and hasattr(obj.data, "use_auto_smooth"):
        obj.data.use_auto_smooth = True
        obj.data.auto_smooth_angle = math.radians(angle)


def uv_cube(obj, scale=0.38):
    if not obj.data.uv_layers:
        obj.data.uv_layers.new(name="UVMap")
    activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.cube_project(cube_size=scale, correct_aspect=True)
    bpy.ops.object.mode_set(mode="OBJECT")


def assign_weights(obj, fn):
    groups = {}
    for v in obj.data.vertices:
        p = v.co
        for bone, weight in fn(p).items():
            if weight <= 1e-4:
                continue
            group = groups.get(bone)
            if group is None:
                group = obj.vertex_groups.get(bone) or obj.vertex_groups.new(name=bone)
                groups[bone] = group
            group.add([v.index], min(1.0, weight), "REPLACE")


def finalize(obj, mat, weight_fn, bevel=None, subsurf=None, solidify=None,
             smooth=True, angle=49.0, uv="cube"):
    if solidify is not None:
        mod = obj.modifiers.new("Solidify", "SOLIDIFY")
        mod.thickness = solidify
        mod.offset = 0.0
    if bevel is not None:
        mod = obj.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(30)
        mod.use_clamp_overlap = True
    if subsurf is not None:
        mod = obj.modifiers.new("Subsurf", "SUBSURF")
        mod.levels = subsurf
        mod.render_levels = subsurf
    obj.data.materials.append(mat)
    activate(obj)
    for mod in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    shade(obj, smooth, angle)
    if uv == "cube":
        uv_cube(obj)
    assign_weights(obj, weight_fn)
    PARTS.append(obj)
    return obj


def loft(name, rings, segments=24, uv_scale=0.34):
    """rings: (z, rx, ry[, cx, cy]) ordered bottom to top."""
    verts = []
    centers = []
    for ring in rings:
        z, rx, ry = ring[0], ring[1], ring[2]
        cx = ring[3] if len(ring) > 3 else 0.0
        cy = ring[4] if len(ring) > 4 else 0.0
        centers.append((cx, cy, z))
        for i in range(segments):
            a = TAU * i / segments
            verts.append((cx + rx * math.cos(a), cy + ry * math.sin(a), z))
    faces = []
    for r in range(len(rings) - 1):
        for i in range(segments):
            a = r * segments + i
            b = r * segments + (i + 1) % segments
            c = (r + 1) * segments + (i + 1) % segments
            d = (r + 1) * segments + i
            faces.append((a, b, c, d))
    if rings[0][1] > 1e-5:
        cx, cy, z = centers[0]
        idx = len(verts)
        verts.append((cx, cy, z))
        for i in range(segments):
            faces.append((idx, (i + 1) % segments, i))
    if rings[-1][1] > 1e-5:
        cx, cy, z = centers[-1]
        idx = len(verts)
        verts.append((cx, cy, z))
        base = (len(rings) - 1) * segments
        for i in range(segments):
            faces.append((idx, base + i, base + (i + 1) % segments))

    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    recalc_normals(mesh)

    z0 = rings[0][0]
    avg_r = sum((r[1] + r[2]) * 0.5 for r in rings) / len(rings)
    tiles = max(1.0, round(TAU * avg_r / uv_scale))
    layer = mesh.uv_layers.new(name="UVMap")
    for poly in mesh.polygons:
        for li in poly.loop_indices:
            vi = mesh.loops[li].vertex_index
            x, y, z = verts[vi]
            ang = math.atan2(y, x) % TAU
            u = ang / TAU * tiles
            v = (z - z0) / uv_scale
            layer.data[li].uv = (u, v)

    obj = link(bpy.data.objects.new(name, mesh))
    return obj


def loft_y(name, sections, segments=18):
    """sections: (y, rx, rz, cz) -- a tube swept along +Y (useful for boots)."""
    verts = []
    for y, rx, rz, cz in sections:
        for i in range(segments):
            a = TAU * i / segments
            verts.append((rx * math.cos(a), y, cz + rz * math.sin(a)))
    faces = []
    for s in range(len(sections) - 1):
        for i in range(segments):
            a = s * segments + i
            b = s * segments + (i + 1) % segments
            c = (s + 1) * segments + (i + 1) % segments
            d = (s + 1) * segments + i
            faces.append((a, b, c, d))
    for end in (0, -1):
        y, rx, rz, cz = sections[end]
        base = 0 if end == 0 else (len(sections) - 1) * segments
        idx = len(verts)
        verts.append((0.0, y, cz))
        for i in range(segments):
            if end == 0:
                faces.append((idx, (i + 1) % segments, i))
            else:
                faces.append((idx, base + i, base + (i + 1) % segments))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    recalc_normals(mesh)
    return link(bpy.data.objects.new(name, mesh))


def brim_mesh(name, angles=48, rings=3):
    """Fire-helmet brim: snug at the dome, long duckbill at the back."""
    verts = []
    faces = []
    for j in range(rings + 1):
        t = j / rings
        for i in range(angles):
            a = TAU * i / angles
            cx = math.cos(a)
            cy = math.sin(a)
            ix, iy, iz = 0.138 * cx, 0.154 * cy + 0.008, 1.764
            ox = 0.190 * cx
            oy = 0.226 * cy + 0.038 + (0.066 * cy if cy > 0 else 0.0)
            oz = 1.744 - (0.024 * cy if cy > 0 else 0.006)
            x = ix + (ox - ix) * t
            y = iy + (oy - iy) * t
            z = iz + (oz - iz) * (t ** 1.5)
            verts.append((x, y, z))
    for r in range(rings):
        for i in range(angles):
            a = r * angles + i
            b = r * angles + (i + 1) % angles
            c = (r + 1) * angles + (i + 1) % angles
            d = (r + 1) * angles + i
            faces.append((a, b, c, d))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    recalc_normals(mesh)
    return link(bpy.data.objects.new(name, mesh))


def shield_mesh(name, outline, offset=0.006):
    """Pointed helmet front shield wrapped onto the dome surface."""
    n = len(outline)
    cz = sum(z for _, z in outline) / n
    verts = []
    a0 = math.radians(-90)
    rx, ry = dome_r(cz)
    verts.append(((rx + offset) * math.cos(a0), (ry + offset) * math.sin(a0), cz))
    for adeg, z in outline:
        a = math.radians(-90 + adeg)
        rx, ry = dome_r(z)
        verts.append(((rx + offset) * math.cos(a), (ry + offset) * math.sin(a), z))
    faces = [(0, 1 + i, 1 + (i + 1) % n) for i in range(n)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    recalc_normals(mesh)
    return link(bpy.data.objects.new(name, mesh))


def apply_xform(obj):
    activate(obj)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj


def rounded_box(name, size, loc, bevel=0.012, rot=(0, 0, 0), segments=2):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    obj.rotation_euler = rot
    obj.location = loc
    # bake only the scale so the bevel stays uniform
    activate(obj)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return obj


def sphere(name, radius, loc, scale=(1, 1, 1), segments=24, rings=16):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings,
                                         radius=radius, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    obj.location = loc
    return obj


def wrap_panel(name, z0, z1, a0, a1, rx, ry, seg_u=12, seg_v=3, offset=0.006):
    verts = []
    faces = []
    for j in range(seg_v + 1):
        v = j / seg_v
        z = z0 + (z1 - z0) * v
        rx_z = rx(z) if callable(rx) else rx
        ry_z = ry(z) if callable(ry) else ry
        for i in range(seg_u + 1):
            u = i / seg_u
            a = a0 + (a1 - a0) * u
            verts.append(((rx_z + offset) * math.cos(a), (ry_z + offset) * math.sin(a), z))
    for j in range(seg_v):
        for i in range(seg_u):
            a = j * (seg_u + 1) + i
            b = a + 1
            c = a + (seg_u + 1) + 1
            d = a + (seg_u + 1)
            faces.append((a, b, c, d))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    recalc_normals(mesh)
    layer = mesh.uv_layers.new(name="UVMap")
    for poly in mesh.polygons:
        for li in poly.loop_indices:
            vi = mesh.loops[li].vertex_index
            u = (vi % (seg_u + 1)) / seg_u
            v = (vi // (seg_u + 1)) / seg_v
            layer.data[li].uv = (u * 2.0, v * 0.6)
    obj = link(bpy.data.objects.new(name, mesh))
    return obj


def curve_tube(name, points, radius, resolution=12):
    data = bpy.data.curves.new(name, "CURVE")
    data.dimensions = "3D"
    data.bevel_depth = radius
    data.bevel_resolution = 3
    data.resolution_u = resolution
    spline = data.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    for point, co in zip(spline.bezier_points, points):
        point.co = co
        point.handle_left_type = "AUTO"
        point.handle_right_type = "AUTO"
    obj = link(bpy.data.objects.new(name, data))
    activate(obj)
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.active_object
    obj.name = name
    return obj


# ---------------------------------------------------------------------------
# skin weight functions
# ---------------------------------------------------------------------------

def smoothstep(a, b, x):
    if abs(b - a) < 1e-9:
        return 0.0 if x < a else 1.0
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3.0 - 2.0 * t)


def w_torso(p):
    z = p.z
    if z <= 0.97:
        return {"hips": 1.0}
    if z < 1.12:
        t = smoothstep(0.97, 1.12, z)
        return {"hips": 1.0 - t, "spine": t}
    if z < 1.27:
        return {"spine": 1.0}
    if z < 1.43:
        t = smoothstep(1.27, 1.43, z)
        return {"spine": 1.0 - t, "chest": t}
    return {"chest": 1.0}


def w_neck(p):
    t = smoothstep(1.46, 1.60, p.z)
    return {"chest": 1.0 - t, "neck": t}


def w_head(_p):
    return {"head": 1.0}


def w_arm(side):
    ua = f"upper_arm.{side}"
    fa = f"forearm.{side}"
    hand = f"hand.{side}"

    def fn(p):
        z = p.z
        if z >= 1.44:
            t = smoothstep(1.44, 1.52, z)
            return {"chest": 0.4 * t, ua: 1.0 - 0.4 * t}
        if z >= 1.22:
            return {ua: 1.0}
        if z > 1.09:
            t = smoothstep(1.09, 1.22, z)
            return {ua: t, fa: 1.0 - t}
        if z > 0.94:
            return {fa: 1.0}
        if z > 0.86:
            t = smoothstep(0.86, 0.94, z)
            return {fa: t, hand: 1.0 - t}
        return {hand: 1.0}

    return fn


def w_shoulder(side):
    ua = f"upper_arm.{side}"

    def fn(p):
        t = smoothstep(1.40, 1.50, p.z)
        return {"chest": 0.45 + 0.25 * t, ua: 0.55 - 0.25 * t}

    return fn


def w_leg(side):
    th = f"thigh.{side}"
    sh = f"shin.{side}"
    ft = f"foot.{side}"

    def fn(p):
        z = p.z
        if z >= 0.97:
            return {"hips": 1.0}
        if z > 0.88:
            t = smoothstep(0.88, 0.97, z)
            return {"hips": t, th: 1.0 - t}
        if z > 0.60:
            return {th: 1.0}
        if z > 0.46:
            t = smoothstep(0.46, 0.60, z)
            return {th: t, sh: 1.0 - t}
        if z > 0.20:
            return {sh: 1.0}
        if z > 0.13:
            t = smoothstep(0.13, 0.20, z)
            return {sh: t, ft: 1.0 - t}
        return {ft: 1.0}

    return fn


def w_boot(side):
    sh = f"shin.{side}"
    ft = f"foot.{side}"

    def fn(p):
        return {sh: 0.7, ft: 0.3}

    return fn


def w_foot(side):
    return lambda _p: {f"foot.{side}": 1.0}


def w_hand(side):
    return lambda _p: {f"hand.{side}": 1.0}


# ---------------------------------------------------------------------------
# coat profile (kept in one place so trim follows the shell)
# ---------------------------------------------------------------------------

COAT_PROFILE = [
    (0.870, 0.246, 0.166),
    (0.930, 0.236, 0.160),
    (1.010, 0.206, 0.148),
    (1.085, 0.198, 0.144),
    (1.170, 0.203, 0.148),
    (1.260, 0.214, 0.156),
    (1.350, 0.220, 0.160),
    (1.420, 0.212, 0.156),
    (1.470, 0.188, 0.144),
    (1.505, 0.146, 0.124),
]


def coat_r(z):
    prof = COAT_PROFILE
    if z <= prof[0][0]:
        return prof[0][1], prof[0][2]
    if z >= prof[-1][0]:
        return prof[-1][1], prof[-1][2]
    for i in range(len(prof) - 1):
        z0, rx0, ry0 = prof[i]
        z1, rx1, ry1 = prof[i + 1]
        if z0 <= z <= z1:
            t = (z - z0) / (z1 - z0)
            return rx0 + (rx1 - rx0) * t, ry0 + (ry1 - ry0) * t
    return prof[-1][1], prof[-1][2]


DOME_PROFILE = [
    (1.752, 0.140, 0.156),
    (1.768, 0.152, 0.168),
    (1.792, 0.156, 0.172),
    (1.820, 0.150, 0.166),
    (1.848, 0.136, 0.150),
    (1.874, 0.114, 0.128),
    (1.896, 0.082, 0.094),
    (1.914, 0.044, 0.052),
    (1.922, 0.012, 0.014),
]


def dome_r(z):
    prof = DOME_PROFILE
    if z <= prof[0][0]:
        return prof[0][1], prof[0][2]
    if z >= prof[-1][0]:
        return prof[-1][1], prof[-1][2]
    for i in range(len(prof) - 1):
        z0, rx0, ry0 = prof[i]
        z1, rx1, ry1 = prof[i + 1]
        if z0 <= z <= z1:
            t = (z - z0) / (z1 - z0)
            return rx0 + (rx1 - rx0) * t, ry0 + (ry1 - ry0) * t
    return prof[-1][1], prof[-1][2]


# ---------------------------------------------------------------------------
# body
# ---------------------------------------------------------------------------

# under-suit torso (only the neck/collar area is visible)
finalize(
    loft("TorsoBase", [
        (0.88, 0.168, 0.128),
        (0.97, 0.166, 0.126),
        (1.10, 0.158, 0.122),
        (1.24, 0.174, 0.132),
        (1.36, 0.184, 0.138),
        (1.46, 0.172, 0.130),
        (1.505, 0.128, 0.104),
    ], 28),
    MAT["nomex"], w_torso, smooth=True, uv=None,
)

# neck + head
finalize(
    loft("Neck", [
        (1.455, 0.078, 0.074),
        (1.53, 0.072, 0.069),
        (1.61, 0.076, 0.073),
    ], 20),
    MAT["nomex"], w_neck, smooth=True, uv=None,
)

finalize(
    sphere("Head", 0.118, (0, 0.004, 1.700), (0.95, 0.98, 1.06)),
    MAT["nomex"], w_head, smooth=True,
)

# turnout coat shell
finalize(
    loft("Coat", COAT_PROFILE, 32),
    MAT["coat"], w_torso, smooth=True, uv=None,
)
finalize(
    loft("CoatHem", [
        (0.858, 0.249, 0.168),
        (0.882, 0.252, 0.170),
        (0.905, 0.247, 0.166),
    ], 32),
    MAT["coat_dark"], w_torso, smooth=True, uv=None,
)

# standing collar
finalize(
    loft("Collar", [
        (1.498, 0.128, 0.108),
        (1.548, 0.132, 0.112),
        (1.602, 0.144, 0.122),
    ], 24),
    MAT["coat_dark"], w_torso, solidify=0.012, smooth=True, uv=None,
)

# front storm flap (the zipper stays buried under the flap)
finalize(
    wrap_panel("StormFlap", 0.862, 1.487, -math.radians(99), -math.radians(81),
               lambda z: coat_r(z)[0], lambda z: coat_r(z)[1], 6, 18, offset=0.008),
    MAT["coat"], w_torso, solidify=0.010, bevel=0.005, smooth=True,
)

# reflective bands (silver core + fluoro edges), follow the shell
for tag, z0, z1 in (("Low", 0.948, 0.992), ("High", 1.348, 1.392)):
    rx, ry = coat_r((z0 + z1) * 0.5)
    finalize(
        loft(f"Band{tag}", [
            (z0, rx + 0.005, ry + 0.005),
            (z1, rx + 0.005, ry + 0.005),
        ], 32),
        MAT["reflective"], w_torso, smooth=True, uv=None,
    )
    for e0, e1 in ((z0 - 0.012, z0), (z1, z1 + 0.012)):
        rx2, ry2 = coat_r((e0 + e1) * 0.5)
        finalize(
            loft(f"Band{tag}Edge{e0:.3f}", [
                (e0, rx2 + 0.003, ry2 + 0.003),
                (e1, rx2 + 0.003, ry2 + 0.003),
            ], 32),
            MAT["fluoro"], w_torso, smooth=True, uv=None,
        )

# belt
rx, ry = coat_r(1.062)
finalize(
    loft("Belt", [
        (1.038, rx + 0.007, ry + 0.007),
        (1.086, rx + 0.009, ry + 0.009),
    ], 32),
    MAT["webbing"], w_torso, smooth=True, uv=None,
)
finalize(rounded_box("BeltBuckle", (0.060, 0.022, 0.038), (0, -0.148, 1.062)),
         MAT["steel"], w_torso, bevel=0.006)

# lower bellows pockets + chest pockets (wrapped to the shell)
for tag, a_mid, z0, z1, wdt in (
    ("PocketLowL", math.radians(-110), 0.995, 1.105, math.radians(24)),
    ("PocketLowR", math.radians(-70), 0.995, 1.105, math.radians(24)),
    ("PocketChestL", math.radians(-113), 1.250, 1.342, math.radians(18)),
    ("PocketChestR", math.radians(-67), 1.250, 1.342, math.radians(18)),
):
    rx, ry = coat_r((z0 + z1) * 0.5)
    finalize(
        wrap_panel(tag, z0, z1, a_mid - wdt / 2, a_mid + wdt / 2, rx, ry, 8, 4, offset=0.010),
        MAT["coat"], w_torso, solidify=0.012, bevel=0.006, smooth=True,
    )
    # pocket flap
    rx2, ry2 = coat_r(z1 + 0.006)
    finalize(
        wrap_panel(tag + "Flap", z1 - 0.004, z1 + 0.026,
                   a_mid - wdt / 2 - 0.008, a_mid + wdt / 2 + 0.008, rx2, ry2, 8, 2, offset=0.016),
        MAT["coat_dark"], w_torso, solidify=0.010, bevel=0.005, smooth=True,
    )

# shoulder yoke reinforcement (kept subtle; the sleeve carries the deltoid)
for side, sx in SIDES:
    a0, a1 = (math.radians(158), math.radians(202)) if sx < 0 else (math.radians(-22), math.radians(22))
    yoke = wrap_panel(f"Yoke{side}", 1.432, 1.492, a0, a1,
                      0.196, 0.146, 6, 2, offset=0.006)
    finalize(yoke, MAT["coat_dark"], w_shoulder(side), solidify=0.010, bevel=0.004, smooth=True)

# harness straps (shoulder -> chest -> back)
for side, sx in SIDES:
    pts = [
        (sx * 0.086, -0.144, 1.105),
        (sx * 0.104, -0.146, 1.315),
        (sx * 0.112, -0.030, 1.492),
        (sx * 0.100, 0.116, 1.455),
        (sx * 0.084, 0.168, 1.190),
    ]
    for i in range(len(pts) - 1):
        a = Vector(pts[i])
        b = Vector(pts[i + 1])
        d = b - a
        mid = (a + b) * 0.5
        obj = rounded_box(f"Harness{side}{i}", (0.040, 0.012, d.length + 0.010), (0, 0, 0), 0.005)
        obj.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
        obj.location = mid
        finalize(obj, MAT["webbing"], w_torso, smooth=False)
finalize(rounded_box("ChestStrap", (0.190, 0.012, 0.034), (0, -0.146, 1.252)),
         MAT["webbing"], w_torso, bevel=0.004)
finalize(rounded_box("ChestBuckle", (0.044, 0.020, 0.046), (0, -0.153, 1.252)),
         MAT["steel"], w_torso, bevel=0.005)

# radio on the right harness
finalize(rounded_box("Radio", (0.052, 0.034, 0.096), (0.136, -0.138, 1.286)),
         MAT["rubber"], w_torso, bevel=0.008)
finalize(loft("RadioAntenna", [
    (1.326, 0.0042, 0.0042, 0.152, -0.138),
    (1.436, 0.0030, 0.0030, 0.152, -0.138),
], 8), MAT["rubber"], w_torso, smooth=True, uv=None)
finalize(rounded_box("RadioKnob", (0.013, 0.009, 0.013), (0.136, -0.154, 1.320)),
         MAT["accent"], w_torso, bevel=0.002)

# small ID tape
rx, ry = coat_r(1.365)
finalize(
    wrap_panel("NameTape", 1.352, 1.378, math.radians(-118), math.radians(-98),
               rx, ry, 4, 1, offset=0.010),
    MAT["reflective"], w_torso, solidify=0.006, smooth=True,
)

# ---------------------------------------------------------------------------
# SCBA
# ---------------------------------------------------------------------------

finalize(rounded_box("BackPlate", (0.245, 0.045, 0.335), (0, 0.183, 1.205)),
         MAT["webbing"], w_torso, bevel=0.014)
finalize(loft("Tank", [
    (1.000, 0.020, 0.020, 0.0, 0.238),
    (1.030, 0.058, 0.058, 0.0, 0.238),
    (1.062, 0.090, 0.090, 0.0, 0.238),
    (1.110, 0.096, 0.096, 0.0, 0.238),
    (1.360, 0.096, 0.096, 0.0, 0.238),
    (1.405, 0.088, 0.088, 0.0, 0.238),
    (1.438, 0.052, 0.052, 0.0, 0.238),
    (1.452, 0.018, 0.018, 0.0, 0.238),
], 24), MAT["steel"], w_torso, smooth=True, uv=None)
finalize(loft("TankBand", [
    (1.150, 0.100, 0.100, 0.0, 0.238),
    (1.205, 0.100, 0.100, 0.0, 0.238),
], 24), MAT["webbing"], w_torso, smooth=True, uv=None)
finalize(loft("Valve", [
    (1.448, 0.030, 0.030, 0.0, 0.238),
    (1.492, 0.026, 0.026, 0.0, 0.238),
], 12), MAT["brass"], w_torso, smooth=True, uv=None)
finalize(loft("ValveWheel", [
    (1.488, 0.050, 0.050, 0.0, 0.238),
    (1.502, 0.050, 0.050, 0.0, 0.238),
], 18), MAT["brass"], w_torso, smooth=True, uv=None)
finalize(curve_tube("Hose", [
    (0.010, 0.238, 1.478),
    (0.105, 0.200, 1.500),
    (0.132, 0.080, 1.440),
    (0.112, -0.020, 1.340),
    (0.092, -0.100, 1.262),
], 0.012), MAT["rubber"], w_torso, smooth=True)

# drag-rescue handle on the back
finalize(curve_tube("DragHandle", [
    (-0.070, 0.205, 1.330),
    (-0.078, 0.245, 1.300),
    (0.000, 0.258, 1.292),
    (0.078, 0.245, 1.300),
    (0.070, 0.205, 1.330),
], 0.012), MAT["webbing"], w_torso, smooth=True)

# ---------------------------------------------------------------------------
# arms
# ---------------------------------------------------------------------------

SHOULDER = {"L": Vector((-0.196, 0.0, 1.468)), "R": Vector((0.196, 0.0, 1.468))}
ELBOW = {"L": Vector((-0.2635, 0.0, 1.1757)), "R": Vector((0.2635, 0.0, 1.1757))}
WRIST = {"L": Vector((-0.3254, 0.0, 0.9077)), "R": Vector((0.3254, 0.0, 0.9077))}

for side, sx in SIDES:
    ang = sx * math.radians(13.0)

    def arm_local(obj, origin):
        obj.rotation_euler = (0, ang, 0)
        obj.location = origin
        apply_xform(obj)

    upper = loft(f"UpperArm_{side}", [
        (-0.320, 0.066, 0.065),
        (-0.270, 0.070, 0.069),
        (-0.180, 0.077, 0.075),
        (-0.080, 0.083, 0.080),
        (-0.010, 0.088, 0.085),
        (0.030, 0.074, 0.072),
    ], 20)
    arm_local(upper, SHOULDER[side])
    finalize(upper, MAT["coat"], w_arm(side), smooth=True, uv=None)

    elbow_pad = sphere(f"ElbowPad_{side}", 0.074, (0, 0, 0), (1.0, 0.95, 1.0))
    elbow_pad.location = ELBOW[side]
    apply_xform(elbow_pad)
    finalize(elbow_pad, MAT["coat_dark"], w_arm(side), smooth=True)

    fore = loft(f"Forearm_{side}", [
        (-0.300, 0.058, 0.056),
        (-0.275, 0.061, 0.059),
        (-0.220, 0.062, 0.060),
        (-0.140, 0.066, 0.064),
        (-0.050, 0.070, 0.068),
        (0.020, 0.066, 0.064),
    ], 20)
    fore.location = ELBOW[side]
    fore.rotation_euler = (0, ang, 0)
    apply_xform(fore)
    finalize(fore, MAT["coat"], w_arm(side), smooth=True, uv=None)

    # sleeve reflective band around the forearm
    band = loft(f"SleeveBand_{side}", [
        (-0.255, 0.062, 0.060),
        (-0.215, 0.063, 0.061),
    ], 20)
    band.location = ELBOW[side]
    band.rotation_euler = (0, ang, 0)
    apply_xform(band)
    finalize(band, MAT["reflective"], w_arm(side), smooth=True, uv=None)

    # cuff
    cuff = loft(f"Cuff_{side}", [
        (-0.335, 0.061, 0.059),
        (-0.300, 0.064, 0.062),
        (-0.278, 0.066, 0.064),
    ], 18)
    cuff.location = ELBOW[side]
    cuff.rotation_euler = (0, ang, 0)
    apply_xform(cuff)
    finalize(cuff, MAT["coat_dark"], w_arm(side), smooth=True, uv=None)

    # glove: one continuous lofted mitten + thumb, so it deforms as a hand
    glove = loft(f"Glove_{side}", [
        (0.034, 0.038, 0.030),
        (-0.020, 0.046, 0.036),
        (-0.075, 0.050, 0.038),
        (-0.125, 0.048, 0.035),
        (-0.170, 0.040, 0.030),
        (-0.195, 0.028, 0.022),
        (-0.203, 0.010, 0.008),
    ], 18)
    glove.rotation_euler = (0, ang, 0)
    glove.location = WRIST[side]
    apply_xform(glove)
    finalize(glove, MAT["glove"], w_hand(side), smooth=True, uv=None)

    tx = -sx * 0.050
    tz = -0.058
    ca, sa = math.cos(ang), math.sin(ang)
    wx = WRIST[side].x + tx * ca + tz * sa
    wz = WRIST[side].z - tx * sa + tz * ca
    thumb = sphere(f"Thumb_{side}", 0.021, (0, 0, 0), (0.9, 0.8, 1.6))
    thumb.rotation_euler = (0.55, ang, sx * 0.30)
    thumb.location = (wx, WRIST[side].y - 0.006, wz)
    finalize(thumb, MAT["glove"], w_hand(side), smooth=True)

# ---------------------------------------------------------------------------
# legs
# ---------------------------------------------------------------------------

HIP = {"L": Vector((-0.112, 0.0, 0.950)), "R": Vector((0.112, 0.0, 0.950))}
ANKLE = {"L": Vector((-0.132, 0.0, 0.135)), "R": Vector((0.132, 0.0, 0.135))}

for side, sx in SIDES:
    leg = loft(f"Leg_{side}", [
        (0.135, 0.080, 0.077),
        (0.220, 0.088, 0.084),
        (0.340, 0.095, 0.090),
        (0.450, 0.101, 0.096),
        (0.520, 0.106, 0.100),
        (0.590, 0.110, 0.104),
        (0.700, 0.118, 0.111),
        (0.830, 0.124, 0.117),
        (0.930, 0.120, 0.113),
        (0.980, 0.110, 0.104),
    ], 22)
    leg.location = (sx * 0.118, 0, 0)
    apply_xform(leg)
    finalize(leg, MAT["trousers"], w_leg(side), smooth=True, uv=None)

    # knee reinforcement
    knee = wrap_panel(f"KneePad_{side}", 0.468, 0.602,
                      math.radians(-126), math.radians(-54), 0.108, 0.103, 12, 4, offset=0.006)
    knee.location = (sx * 0.118, 0, 0)
    apply_xform(knee)
    finalize(knee, MAT["trousers_dark"], w_leg(side), solidify=0.012, bevel=0.010, smooth=True)

    # cargo pocket wrapped to the outer thigh
    a_mid = 0.0 if sx > 0 else math.pi
    pocket = wrap_panel(f"Cargo_{side}", 0.675, 0.815,
                        a_mid - math.radians(30), a_mid + math.radians(30),
                        0.119, 0.113, 6, 3, offset=0.010)
    pocket.location = (sx * 0.118, 0, 0)
    apply_xform(pocket)
    finalize(pocket, MAT["trousers_dark"], w_leg(side), solidify=0.012, bevel=0.006, smooth=True)
    flap = wrap_panel(f"CargoFlap_{side}", 0.792, 0.826,
                      a_mid - math.radians(32), a_mid + math.radians(32),
                      0.120, 0.114, 6, 2, offset=0.018)
    flap.location = (sx * 0.118, 0, 0)
    apply_xform(flap)
    finalize(flap, MAT["webbing"], w_leg(side), solidify=0.008, bevel=0.004, smooth=True)

    # trouser cuff over the boot shaft
    cuff = loft(f"TrouserCuff_{side}", [
        (0.250, 0.096, 0.092),
        (0.300, 0.100, 0.096),
        (0.332, 0.096, 0.092),
    ], 18)
    cuff.location = (sx * 0.126, 0, 0)
    apply_xform(cuff)
    finalize(cuff, MAT["trousers_dark"], w_leg(side), smooth=True, uv=None)

    # boot shaft
    shaft = loft(f"BootShaft_{side}", [
        (0.090, 0.079, 0.077),
        (0.160, 0.081, 0.079),
        (0.240, 0.088, 0.085),
        (0.300, 0.094, 0.091),
    ], 20)
    shaft.location = (sx * 0.130, 0.012, 0)
    apply_xform(shaft)
    finalize(shaft, MAT["boot"], w_boot(side), smooth=True, uv=None)

    foot = loft_y(f"BootFoot_{side}", [
        (0.108, 0.070, 0.046, 0.082),
        (0.060, 0.079, 0.048, 0.084),
        (0.000, 0.082, 0.046, 0.082),
        (-0.080, 0.083, 0.042, 0.078),
        (-0.155, 0.081, 0.039, 0.075),
        (-0.212, 0.070, 0.035, 0.071),
        (-0.244, 0.045, 0.026, 0.062),
    ], 20)
    foot.location = (sx * 0.130, -0.010, 0)
    apply_xform(foot)
    finalize(foot, MAT["boot"], w_foot(side), smooth=True)

    sole = loft_y(f"Sole_{side}", [
        (0.112, 0.074, 0.020, 0.022),
        (0.055, 0.083, 0.019, 0.019),
        (0.000, 0.086, 0.018, 0.018),
        (-0.090, 0.087, 0.017, 0.017),
        (-0.170, 0.084, 0.017, 0.017),
        (-0.225, 0.072, 0.016, 0.016),
        (-0.250, 0.048, 0.014, 0.016),
    ], 16)
    sole.location = (sx * 0.130, -0.010, 0)
    apply_xform(sole)
    finalize(sole, MAT["sole"], w_foot(side), smooth=True)

    # laces
    for i, z in enumerate((0.175, 0.215, 0.255)):
        lace = rounded_box(f"Lace{side}{i}", (0.068, 0.018, 0.010),
                           (sx * 0.130, -0.074, z), 0.003)
        finalize(lace, MAT["webbing"], w_boot(side), smooth=False)

# ---------------------------------------------------------------------------
# helmet + mask
# ---------------------------------------------------------------------------

finalize(
    loft("HelmetDome", [
        (1.752, 0.140, 0.156, 0.0, 0.008),
        (1.768, 0.152, 0.168, 0.0, 0.008),
        (1.792, 0.156, 0.172, 0.0, 0.008),
        (1.820, 0.150, 0.166, 0.0, 0.008),
        (1.848, 0.136, 0.150, 0.0, 0.008),
        (1.874, 0.114, 0.128, 0.0, 0.008),
        (1.896, 0.082, 0.094, 0.0, 0.008),
        (1.914, 0.044, 0.052, 0.0, 0.008),
        (1.922, 0.012, 0.014, 0.0, 0.008),
    ], 30),
    MAT["helmet"], w_head, smooth=True, uv=None,
)
# swept brim: short at the front, long duckbill at the back
finalize(brim_mesh("HelmetBrim"), MAT["helmet"], w_head, solidify=0.010,
         bevel=0.004, smooth=True)
# low, wide center ridge
ridge = curve_tube("HelmetCrest", [
    (0.0, -0.175, 1.800),
    (0.0, -0.140, 1.842),
    (0.0, -0.075, 1.874),
    (0.0, 0.000, 1.890),
    (0.0, 0.075, 1.874),
    (0.0, 0.140, 1.842),
    (0.0, 0.185, 1.802),
], 0.017, 10)
ridge.scale = (1.5, 1.0, 0.5)
apply_xform(ridge)
finalize(ridge, MAT["helmet_dark"], w_head, smooth=True)
# pointed leather shield + brass badge
finalize(
    shield_mesh("HelmetShield", [
        (-16, 1.860), (16, 1.860), (16, 1.822),
        (9, 1.796), (0, 1.782), (-9, 1.796), (-16, 1.822),
    ], offset=0.005),
    MAT["leather"], w_head, solidify=0.008, bevel=0.003, smooth=True,
)
finalize(
    shield_mesh("HelmetShieldBadge", [
        (-9, 1.848), (9, 1.848), (9, 1.828),
        (0, 1.816), (-9, 1.828),
    ], offset=0.013),
    MAT["brass"], w_head, solidify=0.004, smooth=True,
)
# head sits low in the helmet; straps live behind the neck curtain

# neck curtain (back of helmet down to collar)
finalize(
    wrap_panel("NeckCurtain", 1.585, 1.772, math.radians(26), math.radians(154),
               0.134, 0.130, 16, 6, offset=0.004),
    MAT["nomex"], w_head, solidify=0.010, bevel=0.004, smooth=True,
)

# SCBA facepiece: rubber frame + single curved lens + side connector
finalize(
    wrap_panel("MaskFrame", 1.628, 1.756, math.radians(-153), math.radians(-27),
               0.108, 0.112, 16, 4, offset=0.006),
    MAT["rubber"], w_head, solidify=0.014, bevel=0.005, smooth=True,
)
finalize(
    wrap_panel("MaskLens", 1.642, 1.748, math.radians(-148), math.radians(-32),
               0.108, 0.112, 16, 4, offset=0.016),
    MAT["lens"], w_head, solidify=0.008, smooth=True,
)
finalize(loft("Regulator", [
    (-0.026, 0.018, 0.018),
    (0.026, 0.018, 0.018),
], 12), MAT["rubber"], w_head, smooth=True, uv=None)
PARTS[-1].rotation_euler = (math.pi / 2, 0, 0)
PARTS[-1].location = (0.062, -0.092, 1.626)
apply_xform(PARTS[-1])
finalize(loft("RegulatorLens", [
    (-0.044, 0.012, 0.012),
    (-0.036, 0.012, 0.012),
], 10), MAT["steel"], w_head, smooth=True, uv=None)
PARTS[-1].rotation_euler = (math.pi / 2, 0, 0)
PARTS[-1].location = (0.062, -0.092, 1.626)
apply_xform(PARTS[-1])

# ---------------------------------------------------------------------------
# merge into one skinned mesh
# ---------------------------------------------------------------------------

bpy.ops.object.select_all(action="DESELECT")
for obj in PARTS:
    obj.select_set(True)
bpy.context.view_layer.objects.active = PARTS[0]
bpy.ops.object.join()
body = bpy.context.active_object
body.name = "FirefighterMesh"
apply_xform(body)


# ---------------------------------------------------------------------------
# baked vertex ambient occlusion (ships inside the GLB as COLOR_0)
# ---------------------------------------------------------------------------

def bake_vertex_ao(obj):
    try:
        if SCENE.world is None:
            world = bpy.data.worlds.new("BakeWorld")
            world.use_nodes = True
            world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
            SCENE.world = world
        activate(obj)
        mesh = obj.data
        attr = mesh.color_attributes.get("AO")
        if attr is None:
            attr = mesh.color_attributes.new(name="AO", type="BYTE_COLOR", domain="POINT")
        mesh.color_attributes.active_color = attr
        SCENE.render.engine = "CYCLES"
        SCENE.cycles.samples = 24
        SCENE.cycles.max_bounces = 3
        SCENE.render.bake.target = "VERTEX_COLORS"
        SCENE.render.bake.use_pass_direct = False
        SCENE.render.bake.use_pass_indirect = False
        bpy.ops.object.bake(type="AO")
        values = [item.color[0] for item in attr.data]
        # Keep the bake as contact shading rather than grime.
        for item in attr.data:
            value = 0.62 + 0.38 * max(0.0, min(1.0, item.color[0]))
            item.color = (value, value, value, 1.0)
        print(
            "AO BAKED verts=%d min=%.3f max=%.3f mean=%.3f"
            % (len(values), min(values), max(values), sum(values) / max(1, len(values)))
        )
        return True
    except Exception as exc:
        print("AO BAKE FAILED:", exc)
        return False


bake_vertex_ao(body)

# ---------------------------------------------------------------------------
# armature
# ---------------------------------------------------------------------------

bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
arm = bpy.context.object
arm.name = "FirefighterRig"
arm.data.name = "FirefighterArmature"
arm.show_in_front = True
ebs = arm.data.edit_bones
for bone in list(ebs):
    ebs.remove(bone)


def edit_bone(name, head, tail, parent=None, connect=False, deform=True, roll_to=(0, 1, 0)):
    bone = ebs.new(name)
    bone.head = head
    bone.tail = tail
    bone.use_deform = deform
    if parent:
        bone.parent = ebs[parent]
        bone.use_connect = connect
    bone.align_roll(Vector(roll_to))
    return bone


edit_bone("root", (0, 0, 0), (0, 0, 0.12), deform=False)
edit_bone("hips", (0, 0, 0.950), (0, 0, 1.070), "root")
edit_bone("spine", (0, 0, 1.070), (0, 0, 1.270), "hips", True)
edit_bone("chest", (0, 0, 1.270), (0, 0, 1.470), "spine", True)
edit_bone("neck", (0, 0, 1.470), (0, 0, 1.600), "chest", True)
edit_bone("head", (0, 0, 1.600), (0, 0, 1.840), "neck", True)

for side, sx in SIDES:
    sh = SHOULDER[side]
    el = ELBOW[side]
    wr = WRIST[side]
    tip = wr + Vector((sx * 0.0400, 0, -0.1800))
    edit_bone(f"shoulder.{side}", (sx * 0.042, 0, 1.456), sh, "chest")
    edit_bone(f"upper_arm.{side}", sh, el, f"shoulder.{side}", True)
    edit_bone(f"forearm.{side}", el, wr, f"upper_arm.{side}", True)
    edit_bone(f"hand.{side}", wr, tip, f"forearm.{side}", True)

    edit_bone(f"thigh.{side}", (sx * 0.112, 0, 0.950), (sx * 0.122, 0, 0.525), "hips")
    edit_bone(f"shin.{side}", (sx * 0.122, 0, 0.525), (sx * 0.132, 0, 0.135),
              f"thigh.{side}", True)
    edit_bone(f"foot.{side}", (sx * 0.132, 0, 0.135), (sx * 0.132, -0.205, 0.055),
              f"shin.{side}", True, roll_to=(0, 0, 1))

bpy.ops.object.mode_set(mode="OBJECT")
for bone in arm.pose.bones:
    bone.rotation_mode = "XYZ"

# parent + skin
body.parent = arm
mod = body.modifiers.new("Armature", "ARMATURE")
mod.object = arm

# axis sanity check: +X rotation should swing a limb backward (+Y)
bpy.context.view_layer.update()
probe = arm.pose.bones["thigh.L"]
probe.rotation_euler = (0.4, 0, 0)
bpy.context.view_layer.update()
print("AXIS thigh.L +0.4X -> tail", tuple(round(v, 3) for v in probe.tail))
probe.rotation_euler = (0, 0, 0)
probe = arm.pose.bones["upper_arm.R"]
probe.rotation_euler = (-0.8, 0, 0)
bpy.context.view_layer.update()
print("AXIS upper_arm.R -0.8X -> hand", tuple(round(v, 3) for v in arm.pose.bones["hand.R"].head))
probe.rotation_euler = (0, 0, 0)
bpy.context.view_layer.update()

# ---------------------------------------------------------------------------
# animation
# ---------------------------------------------------------------------------

arm.animation_data_create()


def clear_pose():
    for pb in arm.pose.bones:
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)


def new_action(name):
    clear_pose()
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    arm.animation_data.action = action
    return action


def key(bone, frame, rot=None, loc=None):
    pb = arm.pose.bones[bone]
    if rot is not None:
        pb.rotation_euler = rot
        pb.keyframe_insert("rotation_euler", frame=frame)
    if loc is not None:
        pb.location = loc
        pb.keyframe_insert("location", frame=frame)


# --- Idle: breathing + weight shift, 96-frame loop
new_action("Idle")
for f in range(1, 98, 8):
    t = (f - 1) / 96.0 * TAU
    breath = math.sin(t)
    sway = math.sin(t * 0.5)
    key("hips", f, (0.004 * breath, 0, 0), loc=(0.004 * sway, 0.004 * breath, 0))
    key("spine", f, (0.008 * breath, 0.006 * sway, 0.004 * sway))
    key("chest", f, (0.014 * breath, 0.008 * sway, 0.006 * sway))
    key("neck", f, (-0.010 * breath, 0.030 * sway, 0))
    key("head", f, (-0.020 + 0.012 * breath, 0.055 * sway, 0.010 * sway))
    key("upper_arm.L", f, (0.020 * breath, 0, 0.030))
    key("upper_arm.R", f, (0.020 * breath, 0, -0.030))
    key("forearm.L", f, (-0.140 - 0.020 * breath, 0, 0))
    key("forearm.R", f, (-0.140 - 0.020 * breath, 0, 0))
    key("hand.L", f, (0.02, 0, 0))
    key("hand.R", f, (0.02, 0, 0))

# --- Walk: 32-frame loop, left heel strike at frame 1
new_action("Walk")
# phase: 0 heel strike, 0.25 stance, 0.5 toe-off, 0.75 swing
LEG_KEYS = (
    (0.00, (-0.40, 0.07, 0.10)),
    (0.25, (-0.02, 0.10, 0.00)),
    (0.50, (0.32, 0.26, -0.34)),
    (0.75, (-0.10, 0.86, 0.16)),
)
for phase, (thigh, knee, foot) in LEG_KEYS:
    for side, offset in (("L", 0.0), ("R", 0.5)):
        frame = 1 + int(round(((phase + offset) % 1.0) * 32))
        key(f"thigh.{side}", frame, (thigh, 0, 0))
        key(f"shin.{side}", frame, (knee, 0, 0))
        key(f"foot.{side}", frame, (foot, 0, 0))
for side in ("L", "R"):
    thigh, knee, foot = LEG_KEYS[0][1]
    key(f"thigh.{side}", 33, (thigh, 0, 0))
    key(f"shin.{side}", 33, (knee, 0, 0))
    key(f"foot.{side}", 33, (foot, 0, 0))

for f in (1, 9, 17, 25, 33):
    p = (f - 1) / 32.0
    cos = math.cos(TAU * p)
    key("upper_arm.L", f, (0.34 * cos, 0, 0.035))
    key("upper_arm.R", f, (-0.34 * cos, 0, -0.035))
    key("forearm.L", f, (-0.24 - 0.10 * max(0.0, -cos), 0, 0))
    key("forearm.R", f, (-0.24 - 0.10 * max(0.0, cos), 0, 0))
    key("hips", f, (0, -0.060 * cos, 0.020 * math.sin(TAU * p)),
        loc=(0.014 * math.sin(TAU * p), -0.012 * math.cos(2 * TAU * p), 0))
    key("spine", f, (0.030, 0.030 * cos, 0))
    key("chest", f, (0.020, 0.080 * cos, 0))
    key("neck", f, (-0.020, -0.030 * cos, 0))
    key("head", f, (-0.030, -0.040 * cos, 0))

# --- Reach: right hand to the door handle, with anticipation and settle
new_action("Reach")
REST = {
    "upper_arm.R": (0.0, 0, -0.03),
    "forearm.R": (-0.14, 0, 0),
    "hand.R": (0.02, 0, 0),
    "chest": (0, 0, 0),
    "spine": (0, 0, 0),
    "neck": (0, 0, 0),
    "head": (-0.02, 0, 0),
    "upper_arm.L": (0.0, 0, 0.03),
    "forearm.L": (-0.14, 0, 0),
    "hips": (0, 0, 0),
    "thigh.L": (0, 0, 0),
    "thigh.R": (0, 0, 0),
}
REACH = {
    "upper_arm.R": (-1.30, 0.10, -0.12),
    "forearm.R": (-0.32, 0, 0),
    "hand.R": (-0.12, 0, 0),
    "chest": (0.03, -0.14, 0.02),
    "spine": (0.01, -0.06, 0),
    "neck": (0.05, -0.10, 0),
    "head": (0.06, -0.12, 0),
    "upper_arm.L": (0.12, 0, 0.05),
    "forearm.L": (-0.10, 0, 0),
    "hips": (0, -0.04, 0),
    "thigh.L": (-0.10, 0, 0),
    "thigh.R": (0.06, 0, 0),
}
ANTICIPATE = {
    "upper_arm.R": (0.18, 0, -0.04),
    "chest": (0.04, 0.03, 0),
    "head": (-0.03, 0.04, 0),
    "hips": (0, 0.02, 0),
}
for bone, rot in REST.items():
    key(bone, 1, rot)
for bone, rot in ANTICIPATE.items():
    key(bone, 7, rot)
for bone, rot in REACH.items():
    key(bone, 16, rot)
for bone, rot in REACH.items():
    key(bone, 24, (rot[0] * 0.98, rot[1] * 0.98, rot[2] * 0.98))
for bone, rot in REST.items():
    key(bone, 34, rot)
for bone, rot in REST.items():
    key(bone, 42, rot)

clear_pose()
arm.animation_data.action = None
SCENE.frame_set(1)

print("ACTIONS", [(a.name, tuple(round(v, 2) for v in a.frame_range)) for a in bpy.data.actions])

# ---------------------------------------------------------------------------
# preview render
# ---------------------------------------------------------------------------

def setup_preview():
    SCENE.render.engine = "CYCLES"
    SCENE.cycles.samples = 40
    SCENE.cycles.use_denoising = False
    SCENE.cycles.max_bounces = 6
    SCENE.render.resolution_x = 660
    SCENE.render.resolution_y = 900
    SCENE.render.film_transparent = False
    SCENE.view_settings.view_transform = "AgX"

    world = bpy.data.worlds.new("PreviewWorld")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.032, 0.038, 0.044, 1)
    bg.inputs["Strength"].default_value = 0.85
    SCENE.world = world

    bpy.ops.mesh.primitive_plane_add(size=14, location=(0, 0, -0.004))
    floor = bpy.context.active_object
    floor.data.materials.append(make_material("PreviewFloor", "#2f353a", 0.88, 0.0))

    def area(name, loc, energy, size, color):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        data.color = color
        obj = link(bpy.data.objects.new(name, data))
        obj.location = loc
        direction = Vector((0, 0, 1.05)) - Vector(loc)
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        return obj

    area("Key", (2.6, -3.4, 3.2), 520, 2.0, (1.0, 0.87, 0.72))
    area("Fill", (-3.0, -2.2, 1.9), 190, 2.8, (0.60, 0.75, 0.96))
    area("Rim", (0.6, 3.2, 2.9), 440, 1.5, (1.0, 0.70, 0.44))
    area("Top", (0.0, 0.6, 4.2), 160, 3.0, (0.85, 0.90, 1.0))

    cam_data = bpy.data.cameras.new("PreviewCamera")
    cam_data.sensor_fit = "VERTICAL"
    cam_data.lens = 58
    cam = link(bpy.data.objects.new("PreviewCamera", cam_data))
    SCENE.camera = cam
    return cam


def render_shot(cam, name, loc, target=(0, 0, 0.98), res=(660, 900), lens=None):
    if lens is not None:
        cam.data.lens = lens
    cam.location = loc
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    SCENE.render.resolution_x, SCENE.render.resolution_y = res
    SCENE.render.filepath = os.path.join(SHOT_DIR, name + ".png")
    bpy.ops.render.render(write_still=True)
    print("SHOT", SCENE.render.filepath)


cam = setup_preview()

render_shot(cam, "hero", (3.0, -4.4, 1.58))
render_shot(cam, "front", (0.0, -5.4, 1.06))
render_shot(cam, "back", (-2.1, 4.9, 1.56))
render_shot(cam, "bust", (0.70, -1.60, 1.90), target=(0, 0, 1.79), lens=85)
render_shot(cam, "legs", (1.15, -2.35, 0.78), target=(0, 0, 0.42), lens=75)

arm.animation_data.action = bpy.data.actions["Walk"]
SCENE.frame_set(9)
render_shot(cam, "walk", (3.7, -2.9, 1.42), target=(0, 0, 0.95), lens=58)
arm.animation_data.action = bpy.data.actions["Reach"]
SCENE.frame_set(16)
render_shot(cam, "reach", (3.3, -3.7, 1.55), target=(0, 0, 1.05), lens=58)

arm.animation_data.action = None
clear_pose()
SCENE.frame_set(1)

# keep the committed hero preview in sync with the QA contact sheet
shutil.copyfile(os.path.join(SHOT_DIR, "hero.png"), PREVIEW)
print("PREVIEW", PREVIEW)

# ---------------------------------------------------------------------------
# export
# ---------------------------------------------------------------------------

bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
arm.select_set(True)
bpy.context.view_layer.objects.active = arm

bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    use_selection=True,
    export_apply=False,
    export_yup=True,
    export_animations=True,
    export_animation_mode="ACTIONS",
    export_nla_strips=False,
    export_anim_single_armature=True,
    export_skins=True,
    export_optimize_animation_size=True,
    export_colors=True,
    export_cameras=False,
    export_lights=False,
    export_image_format="WEBP",
    export_image_quality=82,
)

tris = sum(max(0, len(p.vertices) - 2) for p in body.data.polygons)
size = os.path.getsize(OUT)
print(f"EXPORTED {OUT}")
print(f"meshes=1 tris={tris} verts={len(body.data.vertices)} bytes={size}")
