import * as THREE from 'three';

/** Three light bands: the cel-shading ramp shared by characters and props. */
export const toonGradient = (() => {
  const texture = new THREE.DataTexture(new Uint8Array([90, 170, 255]), 3, 1, THREE.RedFormat);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
})();

const materials = new Map<number, THREE.MeshBasicMaterial>();

function outlineMaterial(thickness: number): THREE.MeshBasicMaterial {
  let material = materials.get(thickness);
  if (material) return material;
  material = new THREE.MeshBasicMaterial({ color: '#2a2018', side: THREE.BackSide });
  material.onBeforeCompile = (shader) => {
    // After skinning, so the hull follows the animated (skinned) normal.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <skinning_vertex>',
      `#include <skinning_vertex>
      #ifdef USE_SKINNING
        transformed += normalize(objectNormal) * ${thickness.toFixed(4)};
      #else
        transformed += normalize(normal) * ${thickness.toFixed(4)};
      #endif`,
    );
  };
  material.customProgramCacheKey = () => `outline-${thickness}`;
  materials.set(thickness, material);
  return material;
}

/** Inverted-hull ink line: a back-face copy of the mesh pushed out along its normals (model units). */
export function addOutline(mesh: THREE.Mesh, thickness: number): void {
  const skinned = mesh as THREE.SkinnedMesh;
  let hull: THREE.Mesh;
  if (skinned.isSkinnedMesh) {
    const skinnedHull = new THREE.SkinnedMesh(mesh.geometry, outlineMaterial(thickness));
    skinnedHull.bind(skinned.skeleton, skinned.bindMatrix);
    hull = skinnedHull;
  } else {
    hull = new THREE.Mesh(mesh.geometry, outlineMaterial(thickness));
  }
  hull.frustumCulled = mesh.frustumCulled;
  mesh.add(hull);
}
