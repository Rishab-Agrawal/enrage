import * as THREE from 'three';

export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Neutral keeps the painterly palette's hues instead of ACES's warm desaturation.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

/** Canvas pixels per CSS pixel, at most: the frame is bound by how many pixels the grass fills, and MSAA already smooths its edges. */
const MAX_PIXEL_RATIO = 1;

export function resizeRenderer(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
  const canvas = renderer.domElement;
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  if (canvas.width === Math.floor(width * dpr) && canvas.height === Math.floor(height * dpr)) return;
  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
