import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as THREE from 'three';
import { Game } from './game/Game';

const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');
const progress = document.querySelector<HTMLElement>('#title .progress i');
if (!canvas || !progress) throw new Error('Missing game markup.');

const manager = new THREE.LoadingManager();
manager.onProgress = (_url, loaded, total) => (progress.style.transform = `scaleX(${loaded / total})`);
const loader = new GLTFLoader(manager);
const [player, npc] = await Promise.all([loader.loadAsync('models/player.glb'), loader.loadAsync('models/npc.glb')]);

const game = new Game(canvas, { player, npc });
game.start();

if (import.meta.hot) import.meta.hot.dispose(() => game.dispose());
