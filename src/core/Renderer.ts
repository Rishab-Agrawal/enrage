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

export function resizeRenderer(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, maxDpr = 2): void {
  const canvas = renderer.domElement;
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  if (canvas.width === Math.floor(width * dpr) && canvas.height === Math.floor(height * dpr)) return;
  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
