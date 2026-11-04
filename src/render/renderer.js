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
import { texture } from './textures.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { BLACKSHORE } from './style.js';

const SUN_DIR = new THREE.Vector3(...BLACKSHORE.sunDirection).normalize();
const LIGHT_DIR = SUN_DIR.clone().negate();

// Sky-only highlight shoulder (see _buildSky). gain=1/knee=0 is the stock shader.
const SKY_ROLLOFF = { gain: 1.0, knee: 0.32 };

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
    this.renderer.toneMappingExposure = BLACKSHORE.exposure;
    this.renderer.shadowMap.enabled = settings.shadows && this.quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(BLACKSHORE.fogColor, this.quality.fogDensity);

    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, CFG.GRAPHICS.near, this.quality.viewDistance);
    this.camera.rotation.order = 'YXZ';

    this._buildSky();
    this._buildClouds();
    this._buildLights();
    const environment = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environmentTarget = pmrem.fromScene(environment, .04);
    this.scene.environment = this.environmentTarget.texture;
    this.scene.environmentIntensity = BLACKSHORE.environmentIntensity;
    environment.dispose();
    pmrem.dispose();

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

    // The stock Sky shader pushes the horizon toward white when the camera
    // looks anywhere near the sun, so ACES clips large parts of the upper
    // frame. Apply a soft Reinhard shoulder to the sky radiance only (terrain
    // and characters are untouched). Gain lifts the mid-tone blue back up so
    // the gradient survives the compression. The patch is applied to the
    // ShaderMaterial source before its first compile, and the uniforms below
    // let QA prove the patched program is live.
    u.uSkyGain = { value: SKY_ROLLOFF.gain };
    u.uSkyKnee = { value: SKY_ROLLOFF.knee };
    const mat = this.sky.material;
    const marker = 'gl_FragColor = vec4( retColor, 1.0 );';
    if (!mat.fragmentShader.includes('uSkyKnee')) {
      mat.fragmentShader = mat.fragmentShader
        .replace('uniform vec3 up;', 'uniform vec3 up;\n\t\tuniform float uSkyGain;\n\t\tuniform float uSkyKnee;')
        .replace(marker, 'retColor = uSkyGain * retColor / (1.0 + uSkyKnee * retColor);\n\t\t\tgl_FragColor = vec4( retColor, 1.0 );');
    }
    this.skyRolloffApplied = mat.fragmentShader.includes('uSkyKnee')
      && mat.fragmentShader.includes('retColor = uSkyGain');
    mat.needsUpdate = true;
    this.scene.add(this.sky);
  }

  // A single camera-following cloud sheet above the playable map. It is one
  // draw call and one texture fetch per pixel; the alpha map is procedural.
  _buildClouds() {
    const map = texture('clouds');
    if (!map) return;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    const geo = new THREE.CircleGeometry(1100, 64);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uMap: { value: map },
        uOffset: { value: new THREE.Vector2(0, 0) },
        uColor: { value: new THREE.Color(0xe8eef4) },
        uShadow: { value: new THREE.Color(0xa7b4c1) },
        uOpacity: { value: 0.5 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        varying float vR;
        void main() {
          vUv = uv;
          vR = length(position.xz) / 1100.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        uniform vec2 uOffset;
        uniform vec3 uColor, uShadow;
        uniform float uOpacity;
        varying vec2 vUv;
        varying float vR;
        void main() {
          float a = texture2D(uMap, vUv * 3.0 + uOffset).a;
          a = smoothstep(0.05, 0.62, a);
          float fade = 1.0 - smoothstep(0.45, 0.98, vR);
          a *= uOpacity * fade;
          if (a < 0.004) discard;
          vec3 col = mix(uShadow, uColor, smoothstep(0.1, 0.75, a));
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = 260;
    mesh.name = 'clouds';
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    this.scene.add(mesh);
    this.clouds = mesh;
  }

  _buildLights() {
    // Strong unshadowed sky/ground fill keeps shadowed terrain readable. The
    // sun is lifted alongside it so lit surfaces keep their contrast instead of
    // flattening into the fill.
    this.hemi = new THREE.HemisphereLight(BLACKSHORE.skyFill, BLACKSHORE.groundFill, BLACKSHORE.fillIntensity);
    this.scene.add(this.hemi);
    this._buildCSM();
    this.ambient = new THREE.AmbientLight(BLACKSHORE.ambientColor, BLACKSHORE.ambientIntensity);
    this.scene.add(this.ambient);
  }

  _buildCSM() {
    const q = this.quality;
    if (!this.settings.shadows || !q.shadows || q.cascades <= 0) {
      if (this.csm) {
        this.csm.remove();
        for (const light of this.csm.lights) { light.shadow.map?.dispose(); light.shadow.mapPass?.dispose(); }
        this.csm.dispose();
        this.csm = null;
      }
      if (!this.directSun) {
        this.directSun = new THREE.DirectionalLight(BLACKSHORE.sunColor, BLACKSHORE.sunIntensity);
        this.directSun.position.copy(LIGHT_DIR).multiplyScalar(-100);
        this.scene.add(this.directSun);
      }
      this.sun = this.directSun;
      return;
    }
    if (this.directSun) {
      this.directSun.removeFromParent();
      this.directSun.dispose?.();
      this.directSun = null;
    }
    this.csm = new CSM({
      camera: this.camera,
      parent: this.scene,
      cascades: Math.min(2, q.cascades),
      maxFar: q.cascades > 1 ? 130 : 80,
      mode: 'practical',
      shadowMapSize: Math.min(1024, q.shadowMap),
      lightDirection: LIGHT_DIR.clone(),
      lightIntensity: BLACKSHORE.sunIntensity,
      lightNear: 0.5,
      lightFar: 400,
      lightMargin: 35,
      shadowBias: -.00005,
    });
    this.csm.fade = false;
    this.sun = this.csm.lights[0];
    for (const l of this.csm.lights) {
      l.color.setHex(BLACKSHORE.sunColor);
      l.castShadow = this.renderer.shadowMap.enabled;
      l.shadow.normalBias = .015;
    }
  }

  _buildComposer() {
    const bloomWanted = !!(this.settings.bloom && this.quality.bloom !== false);
    if (!bloomWanted) {
      if (this.composer) {
        for (const pass of this.composer.passes) pass.dispose?.();
        this.composer.dispose();
      }
      this.composer = null;
      this.bloom = null;
      return;
    }
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), .17, .42, 1.05);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  registerMaterial(material) {
    if (!material || this._materials.has(material)) return material;
    this._materials.add(material);
    if (this.csm) this.csm.setupMaterial(material);
    const disposed = () => {
      this._materials.delete(material);
      this.csm?.shaders.delete(material);
      material.removeEventListener('dispose', disposed);
    };
    material.addEventListener('dispose', disposed);
    return material;
  }

  registerObject(object) {
    object.traverse(child => {
      if (!child.isMesh) return;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) if (material?.isMeshStandardMaterial) this.registerMaterial(material);
    });
  }

  setUnderwater(underwater) {
    if (this.underwater === underwater) return;
    this.underwater = underwater;
    this.scene.fog.color.setHex(underwater ? 0x416f72 : BLACKSHORE.fogColor);
    this.scene.fog.density = underwater ? .085 : this.quality.fogDensity;
  }

  setQuality(name) {
    const previous = this.quality;
    this.quality = qualityPreset(name);
    this.renderer.setPixelRatio(Math.min(typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1, this.quality.pixelRatio));
    this.renderer.shadowMap.enabled = this.settings.shadows && this.quality.shadows;
    if (previous.cascades !== this.quality.cascades || previous.shadowMap !== this.quality.shadowMap || (!this.csm && this.quality.cascades > 0)) {
      if (this.csm) {
        this.csm.remove();
        for (const light of this.csm.lights) { light.shadow.map?.dispose(); light.shadow.mapPass?.dispose(); }
        this.csm.dispose();
      }
      this._buildCSM();
      if (this.csm) {
        for (const material of this._materials) { this.csm.setupMaterial(material); material.needsUpdate = true; }
      }
    }
    for (const l of (this.csm?.lights || [])) l.castShadow = this.renderer.shadowMap.enabled;
    this.camera.far = this.quality.viewDistance;
    this.camera.updateProjectionMatrix();
    this.scene.fog.density = this.underwater ? .085 : this.quality.fogDensity;
    const bloomWanted = !!(this.settings.bloom && this.quality.bloom !== false);
    if (bloomWanted && !this.composer) this._buildComposer();
    if (!bloomWanted && this.composer) {
      for (const pass of this.composer.passes) pass.dispose?.();
      this.composer.dispose();
      this.composer = null;
      this.bloom = null;
    }
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
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
  }

  render(dt) {
    this.renderer.info.reset();
    if (this.csm) {
      if (this.camera.aspect !== this._shadowAspect || this.camera.fov !== this._shadowFov) {
        this.csm.updateFrustums();
        this._shadowAspect = this.camera.aspect;
        this._shadowFov = this.camera.fov;
      }
      this.csm.update();
    }
    if (this.clouds) {
      const c = this.camera.position;
      this.clouds.position.x = c.x;
      this.clouds.position.z = c.z;
      const u = this.clouds.material.uniforms;
      u.uOffset.value.x += dt * 0.0016;
      u.uOffset.value.y += dt * 0.0007;
    }
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);

    // Animation dt is clamped by the app. Measure real frame intervals instead
    // of reporting a fictitious 10fps floor during slow software rendering.
    const now = performance.now();
    const elapsed = this._lastFrameAt === undefined ? dt : (now - this._lastFrameAt) / 1000;
    this._lastFrameAt = now;
    this._fpsAcc += elapsed; this._fpsFrames++;
    if (this._fpsAcc >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAcc;
      this._fpsAcc = 0; this._fpsFrames = 0;
    }
  }
}
