import math
import os
import sys

import bpy
import addon_utils

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "public", "assets", "firefighter.glb")
os.makedirs(os.path.dirname(OUT), exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)

try:
    addon_utils.enable("io_scene_gltf2")
except Exception:
    pass


def srgb(hex_color):
    h = hex_color.lstrip("#")
    raw = [int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4)]

    def conv(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return tuple(conv(c) for c in raw) + (1.0,)


def material(name, hex_color, roughness=0.8, metallic=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = srgb(hex_color)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat


MAT = {
    "jacket": material("Jacket", "#3f6f5c", 0.78),
    "trousers": material("Trousers", "#263039", 0.9),
    "boot": material("Boot", "#171b1f", 0.7),
    "glove": material("Glove", "#2c3339", 0.75),
    "helmet": material("Helmet", "#d6ab45", 0.42, 0.05),
    "silver": material("Reflective", "#d8dde2", 0.3, 0.25),
    "rubber": material("Rubber", "#14181c", 0.95),
    "steel": material("Steel", "#6b747d", 0.35, 0.6),
    "lens": material("Lens", "#1a222b", 0.2, 0.4),
    "skin": material("Skin", "#c39a7f", 0.9),
}


def empty(name, parent=None, loc=(0, 0, 0)):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = 0.08
    bpy.context.collection.objects.link(obj)
    if parent:
        obj.parent = parent
    obj.location = loc
    return obj


def finish(obj, mat, parent, bevel=0.0, segments=2):
    obj.data.materials.append(mat)
    if parent:
        obj.parent = parent
    if bevel > 0:
        mod = obj.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = segments
        mod.limit_method = "ANGLE"
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def cube(name, size, loc, mat, parent, bevel=0.01):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.location = loc
    return finish(obj, mat, parent, bevel)


def cylinder(name, radius, depth, loc, mat, parent, vertices=12, rot=(0, 0, 0), scale=(1, 1, 1), bevel=0.0):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = rot
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    obj.location = loc
    return finish(obj, mat, parent, bevel)


def sphere(name, radius, loc, mat, parent, scale=(1, 1, 1), segments=16, rings=12):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=radius, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.location = loc
    return finish(obj, mat, parent, 0.0)


root = empty("Firefighter")
hips = empty("Hips", root, (0, 0, 0.9))
torso = empty("Torso", hips, (0, 0, 0))
head = empty("Head", torso, (0, 0, 0.66))

# 躯干
cylinder("Coat", 0.31, 0.58, (0, 0, 0.29), MAT["jacket"], torso, vertices=14, scale=(1, 0.8, 1), bevel=0.015)
cylinder("CoatHem", 0.34, 0.06, (0, 0, 0.03), MAT["jacket"], torso, vertices=14, scale=(1, 0.8, 1), bevel=0.01)
cylinder("Belt", 0.325, 0.07, (0, 0, 0.06), MAT["rubber"], torso, vertices=14, scale=(1, 0.82, 1))
cylinder("BandLow", 0.325, 0.05, (0, 0, 0.22), MAT["silver"], torso, vertices=14, scale=(1, 0.82, 1))
cylinder("BandHigh", 0.315, 0.05, (0, 0, 0.4), MAT["silver"], torso, vertices=14, scale=(1, 0.82, 1))
cylinder("Collar", 0.22, 0.12, (0, 0, 0.58), MAT["jacket"], torso, vertices=12, bevel=0.01)
sphere("ShoulderL", 0.14, (-0.31, 0, 0.5), MAT["jacket"], torso, segments=12, rings=8)
sphere("ShoulderR", 0.14, (0.31, 0, 0.5), MAT["jacket"], torso, segments=12, rings=8)
cube("Radio", (0.07, 0.04, 0.12), (0.18, -0.17, 0.34), MAT["rubber"], torso, 0.006)
cylinder("Antenna", 0.008, 0.16, (0.21, -0.17, 0.48), MAT["rubber"], torso, vertices=6)

# 头与头盔
cylinder("Neck", 0.09, 0.1, (0, 0, -0.03), MAT["rubber"], head, vertices=10)
sphere("Skull", 0.145, (0, 0, 0.04), MAT["rubber"], head, segments=16, rings=12)
sphere("HelmetDome", 0.215, (0, 0, 0.11), MAT["helmet"], head, scale=(1, 0.82, 1.04), segments=18, rings=12)
cylinder("HelmetBrim", 0.245, 0.028, (0, 0, 0.045), MAT["helmet"], head, vertices=20, scale=(1, 1.1, 1), bevel=0.006)
cube("Mask", (0.22, 0.09, 0.14), (0, -0.15, 0), MAT["rubber"], head, 0.012)
cylinder("LensL", 0.055, 0.03, (-0.06, -0.2, 0.01), MAT["lens"], head, vertices=14, rot=(math.pi / 2, 0, 0))
cylinder("LensR", 0.055, 0.03, (0.06, -0.2, 0.01), MAT["lens"], head, vertices=14, rot=(math.pi / 2, 0, 0))
cylinder("Regulator", 0.045, 0.08, (0, -0.2, -0.06), MAT["steel"], head, vertices=10, rot=(math.pi / 2, 0, 0))

# 气瓶与软管
cylinder("Tank", 0.115, 0.48, (0, 0.24, 0.3), MAT["steel"], torso, vertices=12, bevel=0.01)
cylinder("Valve", 0.04, 0.1, (0, 0.24, 0.56), MAT["rubber"], torso, vertices=8)

curve_data = bpy.data.curves.new("HoseCurve", "CURVE")
curve_data.dimensions = "3D"
curve_data.bevel_depth = 0.018
curve_data.bevel_resolution = 2
curve_data.resolution_u = 8
spline = curve_data.splines.new("BEZIER")
spline.bezier_points.add(2)
points = [(0, 0.24, 0.55), (0.2, 0.16, 0.5), (0.08, -0.18, 0.62)]
for point, co in zip(spline.bezier_points, points):
    point.co = co
    point.handle_left_type = "AUTO"
    point.handle_right_type = "AUTO"
hose = bpy.data.objects.new("Hose", curve_data)
bpy.context.collection.objects.link(hose)
bpy.ops.object.select_all(action="DESELECT")
bpy.context.view_layer.objects.active = hose
hose.select_set(True)
bpy.ops.object.convert(target="MESH")
hose = bpy.context.active_object
hose.data.materials.append(MAT["rubber"])
hose.parent = torso


def arm(side, suffix):
    sign = -1 if side == "L" else 1
    shoulder = empty(f"Arm_{suffix}", torso, (sign * 0.34, 0, 0.5))
    cube(f"UpperArm_{suffix}", (0.14, 0.16, 0.3), (0, 0, -0.15), MAT["jacket"], shoulder, 0.02)
    elbow = empty(f"Forearm_{suffix}", shoulder, (0, 0, -0.3))
    cube(f"LowerArm_{suffix}", (0.13, 0.15, 0.28), (0, 0, -0.14), MAT["jacket"], elbow, 0.02)
    cube(f"Glove_{suffix}", (0.15, 0.17, 0.13), (0, -0.01, -0.31), MAT["glove"], elbow, 0.02)
    return shoulder, elbow


arm_l, elbow_l = arm("L", "L")
arm_r, elbow_r = arm("R", "R")


def leg(side, suffix):
    sign = -1 if side == "L" else 1
    hip = empty(f"Leg_{suffix}", hips, (sign * 0.13, 0, 0))
    cube(f"Thigh_{suffix}", (0.18, 0.2, 0.42), (0, 0, -0.21), MAT["trousers"], hip, 0.02)
    knee = empty(f"Shin_{suffix}", hip, (0, 0, -0.42))
    cube(f"ShinMesh_{suffix}", (0.16, 0.18, 0.38), (0, 0, -0.19), MAT["trousers"], knee, 0.02)
    cube(f"Boot_{suffix}", (0.19, 0.34, 0.15), (0, -0.06, -0.4), MAT["boot"], knee, 0.02)
    return hip, knee


leg_l, knee_l = leg("L", "L")
leg_r, knee_r = leg("R", "R")

# 灯光与相机仅用于本地预览，不导出
bpy.ops.object.select_all(action="DESELECT")
for obj in bpy.data.objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = root

bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    use_selection=True,
    export_apply=True,
    export_yup=True,
    export_animations=False,
    export_cameras=False,
    export_lights=False,
)

meshes = [o for o in bpy.data.objects if o.type == "MESH"]
tris = sum(sum(max(0, len(p.vertices) - 2) for p in o.data.polygons) for o in meshes)
size = os.path.getsize(OUT)
print(f"EXPORTED {OUT}")
print(f"meshes={len(meshes)} tris={tris} bytes={size}")
