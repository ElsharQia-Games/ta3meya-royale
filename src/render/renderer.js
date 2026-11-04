// Three.js renderer, sky, lighting (CSM cascaded shadows), fog and post FX.
import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { qualityPreset } from '../settings.js';
import { CFG } from '../../shared/config.js';

const SUN_DIR = new THREE.Vector3(-0.42, 0.66, 0.32).normalize();
const LIGHT_DIR = SUN_DIR.clone().negate();

export class GameRenderer {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;
    this.quality = qualityPreset(settings.quality);

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance', stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, this.quality.pixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = settings.shadows && this.quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xa9b7c6, this.quality.fogDensity);

    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, CFG.GRAPHICS.near, this.quality.viewDistance);
    this.camera.rotation.order = 'YXZ';

    this._buildSky();
    this._buildLights();

    this.composer = null;
    this.bloom = null;
    this._buildComposer();

    this.width = 1; this.height = 1;
    this.fps = 0;
    this._fpsAcc = 0; this._fpsFrames = 0;
    this._materials = new Set();
    this.renderer.info.autoReset = false;

    this.resize();
  }

  _buildSky() {
    this.sky = new Sky();
    this.sky.scale.setScalar(20000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 9;
    u.rayleigh.value = 0.5;
    u.mieCoefficient.value = 0.0028;
    u.mieDirectionalG.value = 0.78;
    u.sunPosition.value.copy(SUN_DIR).multiplyScalar(1000);
    this.scene.add(this.sky);
  }

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0xa8c8ff, 0x4a4032, 1.0);
    this.scene.add(this.hemi);

    const q = this.quality;
    this.csm = new CSM({
      camera: this.camera,
      parent: this.scene,
      cascades: q.cascades,
      maxFar: 240,
      mode: 'practical',
      shadowMapSize: q.shadowMap,
      lightDirection: LIGHT_DIR.clone(),
      lightIntensity: 3.2,
      lightNear: 0.5,
      lightFar: 600,
      lightMargin: 220,
      shadowBias: -0.00035,
    });
    this.csm.fade = false;
    this.sun = this.csm.lights[0];
    for (const l of this.csm.lights) {
      l.castShadow = this.renderer.shadowMap.enabled;
      l.shadow.normalBias = 0.035;
    }
    this.ambient = new THREE.AmbientLight(0x8ea2b8, 0.3);
    this.scene.add(this.ambient);
  }

  _buildComposer() {
    if (!this.settings.bloom || !this.quality.bloom) {
      this.composer = null;
      return;
    }
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.32, 0.55, 0.88);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  registerMaterial(material) {
    if (!material || this._materials.has(material)) return material;
    this._materials.add(material);
    if (this.csm) this.csm.setupMaterial(material);
    return material;
  }

  setQuality(name) {
    this.quality = qualityPreset(name);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, this.quality.pixelRatio));
    this.renderer.shadowMap.enabled = this.settings.shadows && this.quality.shadows;
    for (const l of this.csm.lights) l.castShadow = this.renderer.shadowMap.enabled;
    this.camera.far = this.quality.viewDistance;
    this.camera.updateProjectionMatrix();
    this.scene.fog.density = this.quality.fogDensity;
    const bloomWanted = this.settings.bloom && this.quality.bloom;
    if (bloomWanted && !this.composer) this._buildComposer();
    if (!bloomWanted) this.composer = null;
    this.resize();
  }

  resize() {
    const w = Math.max(1, innerWidth);
    const h = Math.max(1, innerHeight);
    this.width = w; this.height = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setSize(w, h);
      this.bloom?.setSize(w, h);
    }
  }

  render(dt) {
    this.renderer.info.reset();
    if (this.csm) this.csm.update();
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);

    this._fpsAcc += dt; this._fpsFrames++;
    if (this._fpsAcc >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAcc;
      this._fpsAcc = 0; this._fpsFrames = 0;
    }
  }
}
