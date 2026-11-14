// The 3D room. Lighting is ray-traced in Blender and baked into three textures (lm_A / lm_B / lm_C), so nothing here
// computes lights or shadows at run time: surfaces read the baked light and add live reflections on top.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const CDN = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/';
const SCREEN_SIZE = { about: [580, 1024], projects: [1024, 580], contact: [1400, 810] }; // vertical monitor, left monitor, wall board
const B = (x, y, z) => new THREE.Vector3(x, z, -y); // Blender (x, y, z) -> three (x, z, -y)
const RX = 5.4, RY = 4.8; // the room's floor, in metres (must match build_room.py)

// final pass: vignette, a touch of lens fringing and film grain
const FX_SHADER = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uAmount: { value: 1 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uAmount; varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec2 off = c * r2 * 0.012 * uAmount;
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      col *= mix(1.0, smoothstep(0.95, 0.2, sqrt(r2) * 1.15), 0.55 * uAmount);
      float n = fract(sin(dot(vUv * vec2(1731.0, 977.0) + uTime, vec2(12.9898, 78.233))) * 43758.5453);
      col += (n - 0.5) * 0.02 * uAmount * (0.4 + col);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export async function initScene(api) {
  const { canvas, panel, tip, help, reduceMotion, sound, makeCanvas, MIRROR_SHADER, art, openPanel, closePanel } = api;
  const content = api.content;
  const quality = new URLSearchParams(location.search).get('q'); // ?q=high | low | min pins a quality tier
  const pinned = ['high', 'low', 'min'].includes(quality);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  let pixelRatio = Math.min(devicePixelRatio, quality === 'low' || quality === 'min' ? 1 : 1.5);
  renderer.setPixelRatio(pixelRatio);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 700);

  // ------------------------------------------------------------------ load
  let done = 0;
  const step = () => api.progress(++done / 7);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const small = Math.min(innerWidth, innerHeight) * pixelRatio < 900 || renderer.capabilities.maxTextureSize < 4096; // phones get the 2K bake
  const sfx = small || quality === 'low' || quality === 'min' ? '_2k' : '';
  const texLoader = new THREE.TextureLoader();
  const loadTex = (url) => texLoader.loadAsync(url).then((t) => {
    t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso; step();
    return t;
  });
  const draco = new DRACOLoader().setDecoderPath(CDN + 'libs/draco/gltf/');
  const [gltf, petsGltf, toysGltf, lmA, lmB, lmC, meta] = await Promise.all([
    new GLTFLoader().setDRACOLoader(draco).loadAsync('assets/room.glb').then((g) => { step(); return g; }),
    new GLTFLoader().setDRACOLoader(draco).loadAsync('assets/pets.glb').catch((err) => { console.warn('pets unavailable', err); return null; }).then((g) => { step(); return g; }),
    new GLTFLoader().setDRACOLoader(draco).loadAsync('assets/toys.glb').catch((err) => { console.warn('toys unavailable', err); return null; }).then((g) => { step(); return g; }),
    loadTex(`assets/lm_A${sfx}.webp`), loadTex(`assets/lm_B${sfx}.webp`), loadTex(`assets/lm_C${sfx}.webp`),
    fetch('assets/lm.json').then((r) => r.json()).then((j) => { step(); return j; }),
  ]);
  draco.dispose();
  const room = new THREE.Group(); // everything that floats together
  scene.add(room);
  room.add(gltf.scene);
  gltf.scene.updateMatrixWorld(true);
  if (petsGltf) room.add(petsGltf.scene);
  if (toysGltf) room.add(toysGltf.scene);

  // ------------------------------------------------------------------ materials
  const atlas = { A: lmA, B: lmB, C: lmC }; // A: floor and the two far walls, B: everything in the room, C: the two near walls
  // Night and day are two bakes of the same room on the same UVs. Every lit surface blends between them with
  // one shared value (0 = night, 1 = day). Until the day textures arrive, "day" simply points at the night ones.
  const dayU = { value: 0 };
  const ATLASES = ['A', 'B', 'C'];
  const dayTex = Object.fromEntries(ATLASES.map((k) => [k, { value: atlas[k] }]));
  const gain = Object.fromEntries(ATLASES.map((k) => [k, { n: { value: meta[k].gain }, d: { value: meta[k].gain } }]));
  const LM_SAMPLE = /vec4 lightMapTexel = texture2D\( lightMap, vLightMapUv \);/;
  const dayShaderOk = LM_SAMPLE.test(THREE.ShaderChunk.lights_fragment_maps);
  // Walls you can see through. Each wall (B back, L left, F front, R right) has a value from 1 (solid) to 0 (gone);
  // its surfaces dissolve through a fine screen-door pattern, which needs no sorting and works in the reflections too.
  const wallFade = { B: { value: 1 }, L: { value: 1 }, F: { value: 1 }, R: { value: 1 } };
  function addFade(m, side) {
    const prev = m.onBeforeCompile, ownKey = Object.prototype.hasOwnProperty.call(m, 'customProgramCacheKey') ? m.customProgramCacheKey : null;
    m.onBeforeCompile = (sh, rn) => {
      prev.call(m, sh, rn);
      sh.uniforms.uWallFade = wallFade[side];
      sh.fragmentShader = 'uniform float uWallFade;\n' + sh.fragmentShader.replace('void main() {',
        'void main() {\n\tif ( uWallFade < 0.999 ) { float wfN = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) ); if ( wfN >= uWallFade ) discard; }');
    };
    m.customProgramCacheKey = () => (ownKey ? ownKey.call(m) : m.type) + '|wallfade';
    m.userData.side = side;
    return m;
  }
  const litMats = new Map();
  function lit(a, rough = 0.6, side = '') { // baked light + live reflections, three gloss levels per atlas (and per wall)
    const r = rough < 0.33 ? 0.18 : rough < 0.62 ? 0.5 : 0.92;
    const k = a + r + side;
    if (!litMats.has(k)) {
      const m = new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: r, metalness: 0, lightMap: atlas[a], lightMapIntensity: dayShaderOk ? Math.PI : Math.PI * meta[a].gain,
        envMapIntensity: r < 0.3 ? 1.1 : r < 0.6 ? 0.55 : 0.12,
      });
      m.onBeforeCompile = (s) => {
        Object.assign(s.uniforms, { uDay: dayU, lightMapDay: dayTex[a], uGainN: gain[a].n, uGainD: gain[a].d });
        let chunk = THREE.ShaderChunk.lights_fragment_maps
          // the environment map is for reflections only; all diffuse light is already in the bake
          .replace(/iblIrradiance \+= getIBLIrradiance\( [\w.]+ \);/, '');
        if (dayShaderOk) {
          chunk = chunk.replace(LM_SAMPLE, 'vec4 lightMapTexel = vec4( mix( texture2D( lightMap, vLightMapUv ).rgb * uGainN, texture2D( lightMapDay, vLightMapUv ).rgb * uGainD, uDay ), 1.0 );');
          s.fragmentShader = 'uniform float uDay; uniform float uGainN; uniform float uGainD; uniform sampler2D lightMapDay;\n' + s.fragmentShader;
        }
        s.fragmentShader = s.fragmentShader.replace('#include <lights_fragment_maps>', chunk);
      };
      m.customProgramCacheKey = () => 'lit-day-night';
      if (side) addFade(m, side);
      litMats.set(k, m);
    }
    return litMats.get(k);
  }
  const ANIM_GLOW = /^(LED_|Keyboard_Glow|PC_RAM|PC_GPU|PC_FanRing|PC_CpuRing|Console_LED|Mic_Ring|Hex\d|Neon_Name|Lamp_Shade|RingLight|Holo_Ring|LightBar|Candle\d|Wick\d|Gem$|PowerLED)/;
  const glowShared = new Map();
  function glowMat(src, own) {
    const make = () => {
      const c = (src.emissive && src.emissive.getHex() ? src.emissive : src.color).clone();
      c.multiplyScalar((src.userData.web ?? 1.8) / Math.max(c.r, c.g, c.b, 1e-3));
      return new THREE.MeshBasicMaterial({ color: c, toneMapped: false });
    };
    if (own) return make();
    if (!glowShared.has(src)) glowShared.set(src, make());
    return glowShared.get(src);
  }
  const flatShared = new Map();
  const flatMat = (src) => flatShared.get(src) ?? flatShared.set(src, new THREE.MeshBasicMaterial({ color: src.color.clone() })).get(src);
  const glassMat = new THREE.MeshStandardMaterial({ color: 0xa8b8ff, transparent: true, opacity: 0.12, roughness: 0.04, metalness: 0, envMapIntensity: 1.6, depthWrite: false });

  const flag = (o, k) => { for (let p = o; p; p = p.parent) if (p.userData && p.userData[k] !== undefined) return p.userData[k]; };
  const hotMeshes = [], screens = {}, live = {}, glowers = [], sided = [], platesMeshes = [];
  let arcadeMesh = null, chartMesh = null, tradeMesh = null;
  const PLATE_LEVEL = [0.62, 0.9]; // how brightly the licence plates show at night and by day
  // The cat and dog are lit live (by the room's reflection map plus one soft key light): they move, so they cannot be baked.
  const PET_ENV = [3.6, 1.7]; // how strongly the room lights the animals at night and by day
  const petMatList = [], petKey = { value: new THREE.Vector3(0.25, 0.85, 0.45).normalize() };
  const PET_KEY_N = petKey.value.clone(), PET_KEY_D = new THREE.Vector3(-0.65, 0.6, -0.45).normalize(); // night: from above; day: from the window
  const petMats = new Map();
  const petMat = (src) => petMats.get(src) ?? petMats.set(src, new THREE.MeshStandardMaterial({ color: src.color.clone(), roughness: 0.85, metalness: 0, envMapIntensity: 2.2 })).get(src);
  let waterMesh = null; // the aquarium's water volume, and where its bubbles rise from
  const airStone = new THREE.Vector3();
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.material, md = src.userData || {};
    if (o.name === 'Aq_AirStone') o.getWorldPosition(airStone);
    if (md.water) { waterMesh = o; return; }
    const side = flag(o, 'side') || '';
    if (side) { o.userData.side = side; sided.push(o); }
    const hs = o.name.match(/^HS_([a-z]+)_(\w+)$/);
    // the right-hand monitor (the video player) has no panel of its own: clicking it opens Projects
    if (hs) { o.userData.key = hs[1] === 'trade' ? 'projects' : hs[1]; hotMeshes.push(o); }
    if (md.screen) {
      if (hs && hs[1] === 'trade') { tradeMesh = o; return; }
      if (o.name === 'Chart_screen') { chartMesh = o; return; }
      if (o.name.startsWith('Plates_screen')) { platesMeshes.push(o); return; }
      if (o.name === 'Arcade_screen') { arcadeMesh = o; o.userData.key = 'arcade'; hotMeshes.push(o); return; }
      if (!hs || !SCREEN_SIZE[hs[1]]) return; // a screen this page has no content for keeps its plain material
      const key = hs[1], [cv, ctx] = makeCanvas(...SCREEN_SIZE[key]);
      ({ about: art.drawAbout, projects: art.drawProjects, contact: art.drawContact })[key](cv, ctx);
      const tex = new THREE.CanvasTexture(cv);
      tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = maxAniso;
      live[key] = { cv, ctx, tex };
      screens[key] = o;
      o.material = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
    } else if (md.pet) o.material = petMat(src);
    else if (md.glass) o.material = glassMat;
    else if (md.flat) o.material = flatMat(src);
    else if (md.glow) {
      const own = ANIM_GLOW.test(o.name);
      o.material = glowMat(src, own);
      if (own) { o.userData.base = o.material.color.clone(); glowers.push(o); }
    } else o.material = lit(flag(o, 'atlas') ?? 'B', src.name === 'Floor' ? 0.95 : md.rough, side); // the floor gets its gloss from the real mirror instead
  });
  const baseLevel = (k) => (k === 'contact' ? 0.5 : 0.95);
  for (const k in screens) screens[k].material.color.setScalar(baseLevel(k));

  // ------------------------------------------------------------------ fuse static meshes (few draw calls)
  const isLit = new Set(litMats.values());
  const animRoot = (o) => { let r = null; for (let p = o; p; p = p.parent) if (p.userData && p.userData.anim) r = p; return r; };
  const fuse = new Map();
  gltf.scene.traverse((o) => {
    if (!o.isMesh || !isLit.has(o.material) || /^(HS_|TV_)/.test(o.name)) return;
    const root = animRoot(o);
    if (root && (root === o || root.name !== 'Chair')) return; // individually animated things stay separate
    const target = root || gltf.scene;
    const k = target.uuid + o.material.uuid;
    if (!fuse.has(k)) fuse.set(k, { target, mat: o.material, list: [] });
    fuse.get(k).list.push(o);
  });
  for (const { target, mat, list } of fuse.values()) {
    if (list.length < 2) continue;
    const inv = target.matrixWorld.clone().invert();
    const geos = list.map((o) => {
      const g = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
      Object.keys(g.attributes).forEach((k) => { if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k); });
      return g;
    });
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const m = new THREE.Mesh(merged, mat);
    m.name = 'Fused';
    target.add(m);
    list.forEach((o) => { o.removeFromParent(); o.geometry.dispose(); });
    geos.forEach((g) => g.dispose());
  }

  // ------------------------------------------------------------------ night sky, moon, skyline (the world outside)
  const ZENITH = new THREE.Color(0x04040d), HAZE = new THREE.Color(0x1b1038), HORIZON = new THREE.Color(0x0d0a1e);
  const groundColor = HORIZON.clone().add(HAZE.clone().multiplyScalar(0.55));
  scene.background = groundColor;
  const sky = new THREE.Group();
  scene.add(sky);
  sky.add(new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uZenith: { value: ZENITH }, uHorizon: { value: HORIZON }, uHaze: { value: HAZE } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uHaze; varying vec3 vDir;
      void main() { float h = clamp(normalize(vDir).y, 0.0, 1.0);
        gl_FragColor = vec4(mix(uHorizon, uZenith, pow(h, 0.45)) + uHaze * 0.55 * exp(-h * 7.0), 1.0); }`,
  })));
  const [dotCv, dotCx] = makeCanvas(64, 64);
  const dg = dotCx.createRadialGradient(32, 32, 0, 32, 32, 32);
  dg.addColorStop(0, 'rgba(255,255,255,1)'); dg.addColorStop(0.35, 'rgba(255,255,255,0.45)'); dg.addColorStop(1, 'rgba(255,255,255,0)');
  dotCx.fillStyle = dg; dotCx.fillRect(0, 0, 64, 64);
  const dotTex = new THREE.CanvasTexture(dotCv);
  const starLayers = [0, 1].map((layer) => {
    const n = layer ? 160 : 520, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, h = 0.06 + Math.random() * 0.94, r = Math.sqrt(1 - h * h);
      pos.set([Math.cos(a) * r * 480, h * 480, Math.sin(a) * r * 480], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const p = new THREE.Points(g, new THREE.PointsMaterial({ map: dotTex, size: layer ? 3.2 : 2.0, sizeAttenuation: false, transparent: true, opacity: 0.85, depthWrite: false, color: layer ? 0xcfe0ff : 0xffffff }));
    p.layers.set(1); // layer 1 is seen by the main camera only, so stars don't speckle the reflections
    sky.add(p);
    return p;
  });
  camera.layers.enable(1);
  const moonDir = new THREE.Vector3(-0.82, 0.2, 0.45).normalize(); // low over the room as seen from the opening shot
  const moon = new THREE.Mesh(new THREE.CircleGeometry(13, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.25, 1.22, 1.1), toneMapped: false }));
  moon.position.copy(moonDir).multiplyScalar(440); moon.lookAt(0, 0, 0);
  const [glowCv, glowCx] = makeCanvas(128, 128);
  const gg = glowCx.createRadialGradient(64, 64, 0, 64, 64, 64);
  [[0, 0.55], [0.12, 0.3], [0.3, 0.12], [0.6, 0.03], [1, 0]].forEach(([s, a]) => gg.addColorStop(s, `rgba(255,255,255,${a})`));
  glowCx.fillStyle = gg; glowCx.fillRect(0, 0, 128, 128);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(glowCv), color: 0x8fa8ff, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending }));
  halo.position.copy(moonDir).multiplyScalar(438); halo.scale.setScalar(150);
  sky.add(moon, halo);
  let skyline = null, skylineMap = null;
  { // skyline: one merged mesh of towers with lit windows
    const [wc, wx] = makeCanvas(128, 128);
    wx.fillStyle = '#06050c'; wx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      const r = Math.random();
      if (r > 0.2) continue;
      wx.fillStyle = r < 0.15 ? '#ffd9a0' : r < 0.18 ? '#9fe8ff' : '#ff9ad0';
      wx.globalAlpha = 0.25 + Math.random() * 0.6;
      wx.fillRect(i * 16 + 4, j * 16 + 4, 8, 9);
    }
    const wt = new THREE.CanvasTexture(wc);
    wt.wrapS = wt.wrapT = THREE.RepeatWrapping; wt.colorSpace = THREE.SRGBColorSpace;
    const towers = [];
    for (let i = 0; i < 110; i++) {
      // kept low on the horizon so their reflections only show at shallow viewing angles
      const a = Math.random() * Math.PI * 2, d = 70 + Math.random() * 150, w = 6 + Math.random() * 10, h = 5 + Math.random() * Math.random() * 0.17 * d, dp = 6 + Math.random() * 10;
      const g = new THREE.BoxGeometry(w, h, dp), uv = g.attributes.uv;
      for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * Math.max(1, Math.round(w / 3)), uv.getY(k) * Math.max(1, Math.round(h / 3)));
      g.rotateY(Math.random() * Math.PI); g.translate(2.1 + Math.cos(a) * d, h / 2 - 0.1, -1.8 + Math.sin(a) * d);
      towers.push(g);
    }
    skylineMap = wt;
    skyline = new THREE.Mesh(mergeGeometries(towers, false), new THREE.MeshBasicMaterial({ map: wt, color: 0x8d87ad }));
    sky.add(skyline);
    towers.forEach((g) => g.dispose());
  }

  // ------------------------------------------------------------------ pivots for things that move as a group
  const N = (name) => gltf.scene.getObjectByName(name);
  const all = (re) => { const out = []; gltf.scene.traverse((o) => { if (re.test(o.name)) out.push(o); }); return out; };
  function pivot(parts) {
    parts = parts.filter(Boolean);
    if (!parts.length) return null;
    const bb = new THREE.Box3();
    parts.forEach((p) => bb.expandByObject(p));
    const g = new THREE.Group();
    g.position.copy(bb.getCenter(new THREE.Vector3()));
    room.add(g);
    parts.forEach((p) => g.attach(p));
    return g;
  }
  const fans = all(/^PC_Fan\d$/), books = all(/^Book\d$/), ship = all(/^ShipBox\d$/), lids = all(/^ShoeLid\d$/), drawers = all(/^Drawer\d$/);
  const plants = all(/^Plant_[A-Za-z]+$/), penguins = all(/^Penguin\d$/);
  penguins.forEach((o) => { o.userData.p = o.position.clone(); });
  const chair = N('Chair'), car = N('Car'), gem = N('Gem'), trophy = N('Trophy'), shelfCam = N('ShelfCam'), mouse = N('Mouse');
  const shade = N('Lamp_Shade'), curtain = N('Curtain'), neon = N('Neon_Name'), keyGlow = N('Keyboard_Glow');
  [...fans, ...books, ...ship, ...lids, ...drawers, ...plants, chair, car, gem, trophy, shelfCam, mouse, shade, curtain].forEach((o) => {
    if (o) { o.userData.p = o.position.clone(); o.userData.r = o.rotation.clone(); }
  });
  const poster = pivot([N('Poster'), chartMesh]);
  const board = pivot(all(/^HS_contact_/));
  const leds = glowers.filter((o) => /^(LED_|PC_|Console_LED|Mic_Ring|Holo_Ring|LightBar|PowerLED)/.test(o.name));

  // ------------------------------------------------------------------ mirrors: glossy floor + reflective ground
  const mirrorSize = () => [Math.round(innerWidth * pixelRatio * 0.5), Math.round(innerHeight * pixelRatio * 0.5)];
  function makeMirror(w, d, pos, uniforms) {
    const [tw, th] = mirrorSize();
    const m = new Reflector(new THREE.PlaneGeometry(w, d), { textureWidth: tw, textureHeight: th, clipBias: 0.003, shader: MIRROR_SHADER, color: 0xffffff });
    m.rotateX(-Math.PI / 2); m.position.copy(pos);
    for (const k in uniforms) m.material.uniforms[k].value = uniforms[k];
    return m;
  }
  const roomCenter = new THREE.Vector2(RX / 2, -RY / 2);
  const floorMirror = makeMirror(RX, RY, B(RX / 2, RY / 2, 0.003), { uStrength: 0.42, uCenter: roomCenter, uBlur: 0.005 });
  Object.assign(floorMirror.material, { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  room.add(floorMirror);
  const groundMirror = makeMirror(900, 900, B(RX / 2, RY / 2, -0.2), { uStrength: 0.6, uBase: groundColor.clone(), uCenter: roomCenter, uFade: 55, uBlur: 0.004, uGlow: 0.09 });
  scene.add(groundMirror);
  const mirrors = [floorMirror, groundMirror];
  let frameNo = 0, groundLive = true;
  mirrors.forEach((m, i) => { // the two mirrors take turns, one per frame
    const render = m.onBeforeRender;
    // on phones the floor reflection refreshes every third frame instead of every second
    m.onBeforeRender = function (...a) { if ((frameNo + i) % (small ? 3 : 2) === 0 && (i === 0 || groundLive)) render.apply(this, a); };
  });

  let namePlate = null;
  { // name and tagline lettered on the ground beside the room, facing the default camera
    const [nc, nx] = makeCanvas(1024, 256);
    nx.fillStyle = '#fff'; nx.textAlign = 'center';
    nx.font = '800 118px "Segoe UI", system-ui, sans-serif'; nx.fillText(content.name, 512, 128);
    nx.font = '400 38px "Segoe UI", system-ui, sans-serif'; nx.globalAlpha = 0.75; nx.fillText(content.tagline, 512, 198, 980);
    const nt = new THREE.CanvasTexture(nc);
    nt.colorSpace = THREE.SRGBColorSpace; nt.anisotropy = maxAniso;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 0.7), new THREE.MeshBasicMaterial({ map: nt, transparent: true, opacity: 0.8, depthWrite: false }));
    plate.rotation.x = -Math.PI / 2;
    const holder = new THREE.Group();
    holder.position.copy(B(1.55, RY + 0.95, -0.194)); // on the ground to the lower right of the room in the default view
    holder.rotation.y = Math.atan2(0.7, -0.72);
    holder.add(plate);
    scene.add(holder);
    namePlate = plate;
  }

  // ------------------------------------------------------------------ live extras
  const DUST = 80, dustPos = new Float32Array(DUST * 3), dustSeed = [];
  for (let i = 0; i < DUST; i++) dustSeed.push([0.3 + Math.random() * (RX - 0.6), 0.2 + Math.random() * 2.6, -(0.3 + Math.random() * (RY - 0.6)), Math.random() * 6.28, 0.2 + Math.random() * 0.5]);
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ map: dotTex, size: 0.03, transparent: true, opacity: 0.3, depthWrite: false, color: 0xffd9b0 }));
  dust.frustumCulled = false;
  room.add(dust);


  // hologram: a cloud of points that crumbles onto its projector and reassembles
  const holo = new THREE.Group();
  const HOLO_Y = 0.87;
  holo.position.copy(B(0.25, 2.85, HOLO_Y));
  const knot = new THREE.TorusKnotGeometry(0.06, 0.02, 110, 7);
  const hTarget = Float32Array.from(knot.attributes.position.array), HN = hTarget.length / 3;
  const hPos = Float32Array.from(hTarget), hRand = Float32Array.from({ length: HN * 3 }, () => Math.random() - 0.5);
  const holoGeo = new THREE.BufferGeometry();
  holoGeo.setAttribute('position', new THREE.BufferAttribute(hPos, 3));
  const holoCore = new THREE.Points(holoGeo, new THREE.PointsMaterial({ size: 0.006, color: new THREE.Color(0x27e0ff).multiplyScalar(1.7), toneMapped: false }));
  holoCore.frustumCulled = false;
  const holoRing = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.003, 6, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3d81).multiplyScalar(1.6), toneMapped: false }));
  const holoBeam = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.3, 24, 1, true), new THREE.MeshBasicMaterial({ color: 0x27e0ff, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  holoBeam.rotation.x = Math.PI; holoBeam.position.y = -0.14;
  holo.add(holoCore, holoRing, holoBeam);
  room.add(holo);
  let holoK = -1;

  // a light bar sweeping down each monitor
  const scanBars = [screens.about, screens.projects, tradeMesh].filter(Boolean).map((mesh, i) => {
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    const c = bb.getCenter(new THREE.Vector3()), s = bb.getSize(new THREE.Vector3());
    const n = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.normal, 0).transformDirection(mesh.matrixWorld);
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(Math.hypot(s.x, s.z), s.y * 0.07),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.022, blending: THREE.AdditiveBlending, depthWrite: false }));
    bar.position.copy(c).addScaledVector(n, 0.003);
    bar.lookAt(bar.position.clone().add(n));
    bar.userData = { y: c.y, travel: s.y * 0.86, offset: i * 0.4 };
    room.add(bar);
    return bar;
  });

  // mini arcade machine: a small brick-breaker that plays itself; clicking it drops a coin and restarts the round
  const arcade = { bricks: [], bx: 128, by: 120, vx: 70, vy: -85, px: 128, score: 0, banner: 0, clock: 0 };
  let arcadeTex = null, arcadeCtx = null;
  function arcadeReset() {
    arcade.bricks = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 8; c++) arcade.bricks.push({ x: 12 + c * 29, y: 34 + r * 13, r, alive: true });
    Object.assign(arcade, { bx: 128, by: 120, vx: (Math.random() < 0.5 ? -1 : 1) * 70, vy: -85 });
  }
  function arcadeStep(dt, t) {
    const a = arcade;
    a.bx += a.vx * dt; a.by += a.vy * dt;
    if (a.bx < 8 || a.bx > 248) { a.vx = -a.vx; a.bx = Math.min(248, Math.max(8, a.bx)); }
    if (a.by < 26) { a.vy = Math.abs(a.vy); }
    a.px += (a.bx - a.px) * Math.min(1, dt * 9); // the paddle chases the ball
    if (a.by > 170 && a.vy > 0) { a.vy = -Math.abs(a.vy); a.vx += (a.bx - a.px) * 4 + (Math.random() - 0.5) * 30; a.vx = Math.max(-120, Math.min(120, a.vx)); sound.bounce(); }
    for (const b of a.bricks) {
      if (b.alive && a.bx > b.x && a.bx < b.x + 26 && a.by > b.y && a.by < b.y + 10) { b.alive = false; a.vy = -a.vy; a.score += 10 * (4 - b.r); break; }
    }
    if (!a.bricks.some((b) => b.alive)) arcadeReset();
    const x = arcadeCtx;
    x.fillStyle = '#04040e'; x.fillRect(0, 0, 256, 192);
    x.strokeStyle = '#27e0ff'; x.lineWidth = 2; x.strokeRect(3, 22, 250, 167);
    x.font = '700 12px monospace'; x.textAlign = 'left'; x.fillStyle = '#ff3d81'; x.fillText('SCORE ' + String(a.score).padStart(6, '0'), 6, 15);
    x.textAlign = 'right'; x.fillStyle = '#ffd24a'; x.fillText('HI 042000', 250, 15);
    const cols = ['#ff3d81', '#8b5cff', '#27e0ff', '#3ddc97'];
    for (const b of a.bricks) if (b.alive) { x.fillStyle = cols[b.r]; x.fillRect(b.x, b.y, 26, 10); }
    x.fillStyle = '#fff'; x.fillRect(a.px - 18, 174, 36, 5); x.fillRect(a.bx - 3, a.by - 3, 6, 6);
    x.textAlign = 'center';
    if (a.banner > 0) { a.banner -= dt; x.fillStyle = '#ffd24a'; x.font = '700 18px monospace'; x.fillText('PLAYER 1  GO!', 128, 110); }
    else if (Math.floor(t * 2) % 2) { x.fillStyle = 'rgba(255,255,255,0.85)'; x.font = '700 12px monospace'; x.fillText('INSERT COIN', 128, 140); }
    arcadeTex.needsUpdate = true;
  }
  function arcadeCoin() { arcadeReset(); arcade.score = 0; arcade.banner = 1.6; sound.coin(); }
  if (arcadeMesh) {
    const [ac, ax] = makeCanvas(256, 192);
    arcadeCtx = ax;
    arcadeTex = new THREE.CanvasTexture(ac);
    arcadeTex.flipY = false; arcadeTex.colorSpace = THREE.SRGBColorSpace; arcadeTex.magFilter = THREE.NearestFilter;
    arcadeMesh.material = new THREE.MeshBasicMaterial({ map: arcadeTex, toneMapped: false });
    arcadeReset(); arcadeStep(0, 0);
  }

  // phone in the ring light plays a second real video (a product-turntable "live stream")
  const phoneVideo = Object.assign(document.createElement('video'), { src: 'assets/phone.mp4', loop: true, muted: true, playsInline: true, preload: 'auto' });
  phoneVideo.setAttribute('playsinline', '');
  const phoneTex = new THREE.VideoTexture(phoneVideo);
  phoneTex.colorSpace = THREE.SRGBColorSpace;
  if (!reduceMotion) phoneVideo.play().catch(() => {});
  const phoneAim = new THREE.Vector3(3.3 - 5.1, 0, -(1.45 - 1.5)).normalize();
  const phoneFeed = new THREE.Mesh(new THREE.PlaneGeometry(0.062, 0.134), new THREE.MeshBasicMaterial({ map: phoneTex, toneMapped: false }));
  phoneFeed.position.copy(B(5.1, 1.5, 1.7)).addScaledVector(phoneAim, 0.0085);
  phoneFeed.lookAt(phoneFeed.position.clone().add(phoneAim));
  room.add(phoneFeed);

  const videos = [phoneVideo];
  const videoFaces = [];

  // wall chart: draws a classic price pattern candle by candle, a new one every 10 seconds
  const PATTERNS = [
    { name: 'BULL FLAG', bias: 'bullish continuation', up: true,
      pts: [[0, 0.12], [0.08, 0.18], [0.3, 0.68], [0.36, 0.72], [0.44, 0.62], [0.5, 0.68], [0.58, 0.58], [0.64, 0.63], [0.72, 0.54], [0.78, 0.6], [0.9, 0.88], [1, 0.95]],
      lines: [[0.34, 0.76, 0.8, 0.64], [0.42, 0.6, 0.8, 0.5]] },
    { name: 'HEAD & SHOULDERS', bias: 'bearish reversal', up: false,
      pts: [[0, 0.15], [0.14, 0.52], [0.2, 0.55], [0.3, 0.38], [0.42, 0.8], [0.5, 0.85], [0.62, 0.4], [0.72, 0.56], [0.78, 0.54], [0.86, 0.38], [1, 0.12]],
      lines: [[0.22, 0.36, 0.94, 0.36]] },
    { name: 'INVERSE HEAD & SHOULDERS', bias: 'bullish reversal', up: true,
      pts: [[0, 0.85], [0.14, 0.48], [0.2, 0.45], [0.3, 0.62], [0.42, 0.2], [0.5, 0.15], [0.62, 0.6], [0.72, 0.44], [0.78, 0.46], [0.86, 0.62], [1, 0.88]],
      lines: [[0.22, 0.64, 0.94, 0.64]] },
    { name: 'CUP & HANDLE', bias: 'bullish continuation', up: true,
      pts: [[0, 0.72], [0.06, 0.74], [0.14, 0.55], [0.24, 0.36], [0.36, 0.3], [0.48, 0.36], [0.58, 0.55], [0.66, 0.74], [0.74, 0.66], [0.82, 0.62], [0.88, 0.7], [1, 0.94]],
      lines: [[0.04, 0.77, 0.9, 0.77]] },
    { name: 'DOUBLE BOTTOM', bias: 'bullish reversal', up: true,
      pts: [[0, 0.82], [0.12, 0.6], [0.25, 0.28], [0.38, 0.5], [0.5, 0.56], [0.62, 0.4], [0.72, 0.28], [0.84, 0.5], [0.92, 0.62], [1, 0.9]],
      lines: [[0.16, 0.24, 0.82, 0.24], [0.4, 0.59, 0.96, 0.59]] },
    { name: 'ASCENDING TRIANGLE', bias: 'bullish continuation', up: true,
      pts: [[0, 0.25], [0.12, 0.7], [0.22, 0.4], [0.34, 0.7], [0.44, 0.5], [0.56, 0.7], [0.66, 0.58], [0.78, 0.7], [0.84, 0.64], [0.92, 0.82], [1, 0.95]],
      lines: [[0.08, 0.73, 0.84, 0.73], [0.2, 0.37, 0.84, 0.62]] },
  ];
  const CH_N = 28, CH_CYCLE = 10;
  const hash = (n) => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };
  const priceAt = (pts, x) => {
    for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + (y1 - y0) * ((x - x0) / (x1 - x0 || 1)); }
    return pts[pts.length - 1][1];
  };
  PATTERNS.forEach((p, pi) => {
    p.candles = Array.from({ length: CH_N }, (_, i) => {
      const o = priceAt(p.pts, i / CH_N), c = priceAt(p.pts, (i + 1) / CH_N) + (hash(pi * 50 + i) - 0.5) * 0.022;
      return { o, c, hi: Math.max(o, c) + 0.012 + hash(pi * 90 + i) * 0.04, lo: Math.min(o, c) - 0.012 - hash(pi * 130 + i) * 0.04 };
    });
  });
  const chart = { ctx: null, tex: null, key: -1, pattern: '' };
  let chartClock = 0;
  function drawChart(pi, shown, lineA) {
    const x = chart.ctx, p = PATTERNS[pi], X0 = 44, X1 = 480, Y0 = 170, Y1 = 610;
    const px = (v) => X0 + v * (X1 - X0), py = (v) => Y1 - v * (Y1 - Y0);
    const bg = x.createLinearGradient(0, 0, 0, 700);
    bg.addColorStop(0, '#080b14'); bg.addColorStop(1, '#0c1322');
    x.setLineDash([]); x.shadowBlur = 0; x.fillStyle = bg; x.fillRect(0, 0, 500, 700);
    x.strokeStyle = 'rgba(120,150,220,0.13)'; x.lineWidth = 1;
    for (let g = 0; g <= 5; g++) { x.beginPath(); x.moveTo(X0, py(g / 5)); x.lineTo(X1, py(g / 5)); x.stroke(); }
    for (let g = 0; g <= 7; g++) { x.beginPath(); x.moveTo(px(g / 7), Y0); x.lineTo(px(g / 7), Y1); x.stroke(); }
    x.textAlign = 'left';
    x.fillStyle = '#7f8bb8'; x.font = '600 19px monospace'; x.fillText(`PATTERN ${pi + 1} / ${PATTERNS.length}`, X0, 52);
    x.fillStyle = '#fff'; x.font = '800 34px "Segoe UI", sans-serif'; x.fillText(p.name, X0, 96, X1 - X0);
    x.fillStyle = p.up ? '#3ddc97' : '#ff5c7a'; x.font = '600 20px monospace'; x.fillText((p.up ? '▲ ' : '▼ ') + p.bias, X0, 130);
    const w = (X1 - X0) / CH_N;
    for (let i = 0; i < Math.min(CH_N, Math.ceil(shown)); i++) {
      const cd = p.candles[i], k = Math.min(1, shown - i), c = cd.o + (cd.c - cd.o) * k;
      const hi = Math.max(cd.o, c) + (cd.hi - Math.max(cd.o, cd.c)) * k, lo = Math.min(cd.o, c) - (Math.min(cd.o, cd.c) - cd.lo) * k;
      const col = c >= cd.o ? '#3ddc97' : '#ff5c7a', cx = X0 + (i + 0.5) * w;
      x.fillStyle = col; x.shadowColor = col; x.shadowBlur = 7;
      x.fillRect(cx - 1.3, py(hi), 2.6, py(lo) - py(hi));
      x.fillRect(cx - w * 0.31, py(Math.max(cd.o, c)), w * 0.62, Math.max(2.5, Math.abs(py(c) - py(cd.o))));
    }
    x.shadowBlur = 0;
    if (lineA > 0) {
      x.setLineDash([10, 7]); x.lineWidth = 3; x.strokeStyle = 'rgba(255,210,74,0.95)';
      for (const [a, b, c, d] of p.lines) { x.beginPath(); x.moveTo(px(a), py(b)); x.lineTo(px(a + (c - a) * lineA), py(b + (d - b) * lineA)); x.stroke(); }
      x.setLineDash([]);
    }
    x.fillStyle = '#5f6a92'; x.font = '16px monospace'; x.fillText('SWR / USD  ·  4H', X0, 660);
    x.textAlign = 'right'; x.fillText(shown >= CH_N ? 'pattern complete' : 'forming…', X1, 660);
    chart.tex.needsUpdate = true;
  }
  function tickChart(t) {
    const u = t % (CH_CYCLE * PATTERNS.length), pi = Math.floor(u / CH_CYCLE), local = u % CH_CYCLE;
    const shown = Math.min(1, local / 6.4) * CH_N, lineA = THREE.MathUtils.clamp((local - 6.6) / 1.0, 0, 1);
    const key = pi * 100000 + Math.round(shown * 4) * 20 + Math.round(lineA * 10);
    if (key === chart.key) return;
    chart.key = key; chart.pattern = PATTERNS[pi].name;
    drawChart(pi, shown, lineA);
  }
  if (chartMesh) {
    const [cc, cx] = makeCanvas(500, 700);
    chart.ctx = cx;
    chart.tex = new THREE.CanvasTexture(cc);
    chart.tex.flipY = false; chart.tex.colorSpace = THREE.SRGBColorSpace; chart.tex.anisotropy = maxAniso;
    chartMesh.material = new THREE.MeshBasicMaterial({ map: chart.tex, toneMapped: false });
    drawChart(0, reduceMotion ? CH_N : 0, reduceMotion ? 1 : 0);
  }

  // right-hand monitor: a video site playing one clip after another. Every few seconds the pointer picks the next
  // clip from the "Up next" list. Every clip is drawn here frame by frame: no video files and no outside content.
  const VW = 660, VH = 371; // the player's picture area; clips draw in this space
  const rr = (x, X, Y, W, H, r) => { x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + W, Y, X + W, Y + H, r); x.arcTo(X + W, Y + H, X, Y + H, r); x.arcTo(X, Y + H, X, Y, r); x.arcTo(X, Y, X + W, Y, r); x.closePath(); };
  const vgrad = (x, y0, y1, stops) => { const g = x.createLinearGradient(0, y0, 0, y1); stops.forEach(([o, c]) => g.addColorStop(o, c)); return g; };
  const dot = (x, X, Y, r) => { x.beginPath(); x.arc(X, Y, r, 0, 7); x.fill(); };

  function clipDrive(x, t) { // chase view of a red sports car on a desert road at sunset
    const hz = 170, sway = 46 * Math.sin(t * 0.5), vx = VW / 2 + sway;
    x.fillStyle = vgrad(x, 0, hz, [[0, '#2b1b55'], [0.6, '#c2456b'], [1, '#ffb25e']]); x.fillRect(0, 0, VW, hz);
    x.fillStyle = '#ffe3a1'; dot(x, vx + 90, hz - 8, 34);
    x.fillStyle = '#3a2350'; x.beginPath(); x.moveTo(0, hz);
    for (let i = 0; i <= 13; i++) x.lineTo(i * 55 - 20 - sway * 0.3, hz - 22 - 30 * Math.abs(Math.sin(i * 1.9)));
    x.lineTo(VW, hz); x.fill();
    x.fillStyle = vgrad(x, hz, VH, [[0, '#7a4a4e'], [1, '#3b2c36']]); x.fillRect(0, hz, VW, VH - hz);
    x.fillStyle = '#26232b'; x.beginPath(); x.moveTo(vx - 8, hz); x.lineTo(vx + 8, hz); x.lineTo(VW / 2 + 330, VH); x.lineTo(VW / 2 - 330, VH); x.fill();
    for (let k = 0; k < 9; k++) { // centre dashes rushing toward the camera
      const z = (k / 9 + t * 0.85) % 1, z2 = z * z, y = hz + (VH - hz) * z2, cx = vx + (VW / 2 - vx) * z2;
      x.fillStyle = `rgba(255,224,130,${0.35 + 0.65 * z})`; x.fillRect(cx - 1 - 5 * z2, y, 2 + 10 * z2, 4 + 30 * z2);
    }
    x.strokeStyle = 'rgba(255,255,255,0.55)'; x.lineWidth = 2;
    for (const s of [-1, 1]) { x.beginPath(); x.moveTo(vx + s * 7, hz); x.lineTo(VW / 2 + s * 300, VH); x.stroke(); }
    const cx = VW / 2 - sway * 0.25, cy = 262 + 2 * Math.sin(t * 11);
    x.fillStyle = 'rgba(0,0,0,0.45)'; x.beginPath(); x.ellipse(cx, cy + 62, 120, 12, 0, 0, 7); x.fill();
    for (const s of [-1, 1]) { x.fillStyle = '#0c0b10'; rr(x, cx + s * 94 - 17, cy + 28, 34, 40, 8); x.fill(); } // tyres
    x.fillStyle = '#c8141c'; rr(x, cx - 105, cy, 210, 58, 16); x.fill();   // body
    x.fillStyle = '#e3202a'; rr(x, cx - 78, cy - 34, 156, 46, 20); x.fill(); // cabin
    x.fillStyle = '#1a1420'; rr(x, cx - 64, cy - 27, 128, 26, 12); x.fill(); // rear window
    x.fillStyle = '#ff5a3c'; x.shadowColor = '#ff3b2a'; x.shadowBlur = 14;
    for (const s of [-1, 1]) { dot(x, cx + s * 74, cy + 20, 9); dot(x, cx + s * 52, cy + 20, 9); }
    x.shadowBlur = 0;
    x.fillStyle = '#16131a'; rr(x, cx - 70, cy + 42, 140, 16, 5); x.fill(); // diffuser
    x.fillStyle = 'rgba(255,255,255,0.9)'; x.font = '700 20px monospace'; x.textAlign = 'right';
    x.fillText(`${Math.round(118 + 9 * Math.sin(t * 0.7))} mph`, VW - 18, 34);
  }
  function clipFish(x, t) { // a float on a lake at sunrise; every few seconds something takes it
    const hz = 150, u = t % 6, bite = u > 4.6 && u < 5.4;
    x.fillStyle = vgrad(x, 0, hz, [[0, '#35518c'], [0.65, '#f0a57c'], [1, '#ffd9a0']]); x.fillRect(0, 0, VW, hz);
    x.fillStyle = '#fff1c4'; dot(x, 430, hz - 4, 26);
    x.fillStyle = '#1f3340'; x.beginPath(); x.moveTo(0, hz);
    for (let i = 0; i <= 22; i++) x.lineTo(i * 30, hz - 14 - 12 * Math.abs(Math.sin(i * 2.7)) - (i < 8 ? 18 : 0));
    x.lineTo(VW, hz); x.fill();
    x.fillStyle = vgrad(x, hz, VH, [[0, '#e8a47c'], [0.25, '#5d7fa6'], [1, '#17324e']]); x.fillRect(0, hz, VW, VH - hz);
    x.fillStyle = 'rgba(255,236,190,0.35)'; // sun glitter on the water
    for (let i = 0; i < 14; i++) { const w = 20 + i * 9 + 14 * Math.sin(t * 2 + i); x.fillRect(430 - w / 2 + 6 * Math.sin(t * 1.3 + i * 2), hz + 6 + i * 13, w, 3); }
    x.strokeStyle = 'rgba(255,255,255,0.16)'; x.lineWidth = 1.5;
    for (let i = 0; i < 16; i++) { const y = hz + 14 + i * 14, o = ((t * (10 + i * 2) + i * 97) % (VW + 160)) - 80; x.beginPath(); x.moveTo(o, y); x.lineTo(o + 50 + i * 4, y); x.stroke(); }
    const bx = 250, by = 268 + (bite ? 14 : 3 * Math.sin(t * 2.4)), tipY = 40 + (bite ? 14 : 0);
    for (let k = 0; k < 3; k++) { const a = (t * 0.5 + k / 3) % 1; x.strokeStyle = `rgba(255,255,255,${0.5 * (1 - a)})`; x.beginPath(); x.ellipse(bx, 276, 12 + a * (bite ? 90 : 46), 3 + a * (bite ? 20 : 10), 0, 0, 7); x.stroke(); }
    x.strokeStyle = 'rgba(255,255,255,0.75)'; x.lineWidth = 1.2; x.beginPath(); x.moveTo(VW - 40, tipY); x.quadraticCurveTo(430, bite ? 190 : 150, bx, by - 12); x.stroke();
    x.fillStyle = '#f4f1e8'; dot(x, bx, by, 9);
    x.fillStyle = '#e02f2f'; x.beginPath(); x.arc(bx, by, 9, Math.PI, 0); x.fill();
    x.fillStyle = '#222'; x.fillRect(bx - 1, by - 17, 2, 8);
    x.strokeStyle = '#1b1b20'; x.lineWidth = 7; x.lineCap = 'round'; x.beginPath(); x.moveTo(VW + 10, 210); x.lineTo(VW - 40, tipY); x.stroke();
    if (bite) { x.fillStyle = '#fff'; x.font = '800 30px "Segoe UI", sans-serif'; x.textAlign = 'center'; x.fillText('FISH ON!', VW / 2, 70); }
  }
  function clipPickle(x, t) { // a rally seen from above
    const X0 = 130, Y0 = 26, CW = 400, CH = 320, mid = Y0 + CH / 2, cx = X0 + CW / 2;
    x.fillStyle = '#1d5c4a'; x.fillRect(0, 0, VW, VH);
    x.fillStyle = '#2a7bbf'; x.fillRect(X0, Y0, CW, CH);
    x.fillStyle = '#37a06c'; x.fillRect(X0, mid - 50, CW, 100); // the kitchen
    x.strokeStyle = '#fff'; x.lineWidth = 3; x.strokeRect(X0, Y0, CW, CH);
    x.beginPath(); x.moveTo(X0, mid - 50); x.lineTo(X0 + CW, mid - 50); x.moveTo(X0, mid + 50); x.lineTo(X0 + CW, mid + 50);
    x.moveTo(cx, Y0); x.lineTo(cx, mid - 50); x.moveTo(cx, mid + 50); x.lineTo(cx, Y0 + CH); x.stroke();
    x.strokeStyle = '#11151c'; x.lineWidth = 5; x.beginPath(); x.moveTo(X0 - 12, mid); x.lineTo(X0 + CW + 12, mid); x.stroke(); // net
    const ph = (t * 0.8) % 2, k = ph < 1 ? ph : 2 - ph; // 0 = at the far player, 1 = at the near player
    const bx = cx + 130 * Math.sin(t * 0.9), by = Y0 + 30 + (CH - 60) * k, lift = Math.sin(Math.PI * k) * 26;
    [[cx + (bx - cx) * (1 - k), Y0 + 16, '#ff3d81'], [cx + (bx - cx) * k, Y0 + CH - 16, '#ffd24a']].forEach(([px, py, c], i) => {
      x.fillStyle = 'rgba(0,0,0,0.3)'; x.beginPath(); x.ellipse(px + 5, py + 6, 15, 10, 0, 0, 7); x.fill();
      x.fillStyle = '#19a8a0'; rr(x, px + 12, py - 16 + i * 14, 12, 18, 5); x.fill(); // paddle
      x.fillStyle = c; dot(x, px, py, 13);
      x.fillStyle = '#2a2230'; dot(x, px, py, 6);
    });
    x.fillStyle = 'rgba(0,0,0,0.35)'; x.beginPath(); x.ellipse(bx + lift * 0.45, by + lift * 0.45, 6, 4, 0, 0, 7); x.fill();
    x.fillStyle = '#d9f03c'; dot(x, bx, by - lift * 0.3, 5.5 + lift * 0.1);
    x.fillStyle = 'rgba(0,0,0,0.6)'; rr(x, 14, 14, 100, 54, 8); x.fill();
    x.fillStyle = '#fff'; x.font = '700 15px monospace'; x.textAlign = 'left';
    const pts = Math.floor(t / 2.5) % 11;
    x.fillText(`SWR  ${String(Math.min(11, pts + 2)).padStart(2)}`, 24, 36); x.fillText(`OPP  ${String(pts).padStart(2)}`, 24, 58);
  }
  function clipHighball(x, t) { // a tall glass filling up, with the recipe steps as captions
    x.fillStyle = vgrad(x, 0, VH, [[0, '#1b1210'], [1, '#3a2216']]); x.fillRect(0, 0, VW, VH);
    for (let i = 0; i < 9; i++) { x.fillStyle = `rgba(255,${170 + i * 8},90,0.13)`; dot(x, (i * 83 + 400 + 40 * Math.sin(t * 0.2 + i)) % VW, 40 + (i * 53) % 150, 22 + (i % 3) * 10); }
    x.fillStyle = '#5a3a24'; x.fillRect(0, 300, VW, 71);
    x.fillStyle = 'rgba(255,255,255,0.08)'; x.fillRect(0, 300, VW, 3);
    const gx = 280, gy = 70, gw = 100, gh = 232, u = (t % 8) / 8, fill = Math.min(1, u / 0.7), lvl = gy + gh - 8 - (gh - 34) * fill;
    x.fillStyle = vgrad(x, lvl, gy + gh, [[0, '#f1c46a'], [1, '#c9801e']]); x.fillRect(gx + 5, lvl, gw - 10, gy + gh - 6 - lvl);
    x.fillStyle = 'rgba(255,255,255,0.3)'; // ice
    for (let i = 0; i < 4; i++) { x.save(); x.translate(gx + 31 + (i % 2) * 38, gy + gh - 34 - i * 48 + 3 * Math.sin(t * 1.5 + i)); x.rotate(0.3 * Math.sin(i * 2 + t * 0.3)); x.fillRect(-19, -19, 38, 38); x.restore(); }
    x.fillStyle = 'rgba(255,255,255,0.7)'; // bubbles, only inside the liquid
    const depth = Math.max(8, gy + gh - 10 - lvl);
    for (let i = 0; i < 14; i++) dot(x, gx + 12 + (i * 29) % (gw - 24), gy + gh - 10 - ((t * (40 + i * 6) + i * 37) % depth), 1.6 + (i % 3) * 0.6);
    x.strokeStyle = 'rgba(255,255,255,0.75)'; x.lineWidth = 3; x.strokeRect(gx, gy, gw, gh);
    x.fillStyle = 'rgba(255,255,255,0.12)'; x.fillRect(gx + 8, gy + 6, 10, gh - 16);
    if (u < 0.7) { // the pour: a stream from a tilted bottle
      x.fillStyle = '#e9b458'; x.fillRect(gx + gw / 2 - 3, 34, 6, lvl - 34);
      x.save(); x.translate(gx + gw / 2 - 2, 36); x.rotate(-0.55);
      x.fillStyle = '#2f6b45'; x.fillRect(0, -8, 46, 16); rr(x, 40, -24, 150, 48, 10); x.fill();
      x.fillStyle = '#e6dcc0'; x.fillRect(84, -24, 62, 48);
      x.restore();
    } else { // finished: a lemon wheel on the rim
      x.fillStyle = '#f5d94a'; dot(x, gx + gw - 6, gy + 4, 22); x.fillStyle = '#fbeea0'; dot(x, gx + gw - 6, gy + 4, 16);
    }
    const steps = ['1  Ice to the top', '2  One part whisky', '3  Three parts soda', '4  One gentle stir'];
    x.fillStyle = 'rgba(0,0,0,0.6)'; rr(x, 20, VH - 92, 250, 40, 10); x.fill();
    x.fillStyle = '#fff'; x.font = '700 20px "Segoe UI", sans-serif'; x.textAlign = 'left'; x.fillText(steps[Math.min(3, Math.floor(u * 4))], 36, VH - 65);
  }
  function clipLofi(x, t) { // a spinning record and an equaliser under a night sky
    x.fillStyle = vgrad(x, 0, VH, [[0, '#1a1440'], [0.7, '#5b2a6e'], [1, '#e0637a']]); x.fillRect(0, 0, VW, VH);
    x.fillStyle = '#ffe9c9'; dot(x, 520, 100, 44);
    for (let i = 0; i < 34; i++) { x.fillStyle = `rgba(255,255,255,${0.35 + 0.35 * Math.sin(t * 1.7 + i * 2.3)})`; x.fillRect((i * 137) % VW, (i * 71) % 190, 2, 2); }
    x.fillStyle = '#150f2b';
    for (let i = 0; i < 14; i++) x.fillRect(i * 48 - 6, 250 - 30 - ((i * 53) % 70), 44, 140);
    x.fillStyle = 'rgba(255,214,120,0.8)';
    for (let i = 0; i < 40; i++) if ((i * 7) % 5 < 2) x.fillRect((i * 97) % VW, 215 + (i * 41) % 60, 4, 5);
    const rx = 150, ry = 185;
    x.fillStyle = 'rgba(0,0,0,0.35)'; dot(x, rx + 6, ry + 8, 82);
    x.fillStyle = '#0d0b14'; dot(x, rx, ry, 80);
    x.strokeStyle = 'rgba(255,255,255,0.07)'; x.lineWidth = 1;
    for (let r = 34; r < 78; r += 7) { x.beginPath(); x.arc(rx, ry, r, 0, 7); x.stroke(); }
    x.strokeStyle = 'rgba(255,255,255,0.3)'; x.lineWidth = 3; x.beginPath(); x.arc(rx, ry, 62, t * 2.2, t * 2.2 + 0.7); x.stroke();
    x.fillStyle = '#ff3d81'; dot(x, rx, ry, 26); x.fillStyle = '#0d0b14'; dot(x, rx, ry, 4);
    for (let i = 0; i < 30; i++) { // equaliser
      const h = 14 + 70 * Math.abs(Math.sin(t * 3 + i * 0.7) * Math.sin(t * 1.3 + i * 0.31));
      x.fillStyle = `hsl(${320 - i * 5}, 90%, 62%)`; x.fillRect(260 + i * 13, VH - 30 - h, 9, h);
    }
    x.fillStyle = 'rgba(255,255,255,0.7)'; x.font = '600 13px monospace'; x.textAlign = 'left'; x.fillText('NOW PLAYING', 262, 150);
    x.fillStyle = '#fff'; x.font = '700 24px "Segoe UI", sans-serif'; x.fillText('rice paddies after rain', 262, 180);
  }
  const CLIPS = [
    { title: 'Canyon run in the red one | POV drive', ch: 'Apex Hours', subs: '412K subscribers', views: '1.2M views', len: 754, at: 131, col: '#e3202a', draw: clipDrive },
    { title: 'Sunrise bass on topwater | full session', ch: 'Reel Quiet', subs: '96K subscribers', views: '386K views', len: 1123, at: 402, col: '#5d7fa6', draw: clipFish },
    { title: 'Best pickleball rallies of the month', ch: 'Dink Dynasty', subs: '208K subscribers', views: '842K views', len: 487, at: 57, col: '#37a06c', draw: clipPickle },
    { title: 'How to pour a perfect highball', ch: 'Slow Pour', subs: '1.1M subscribers', views: '2.4M views', len: 312, at: 44, col: '#c9801e', draw: clipHighball },
    { title: 'Lo-fi beats to pack orders to', ch: 'SWR Radio', subs: '58K subscribers', views: '5.1K watching', len: 3600, at: 1987, col: '#8b5cff', draw: clipLofi },
  ];
  const SLOT = 9; // seconds each clip stays on
  const clock2 = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : `${Math.floor(s / 60)}`) + `:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  function wrap2(x, text, X, Y, maxW, lh) { // at most two lines, the second one cut with an ellipsis
    const words = text.split(' '), lines = [''];
    for (const w of words) {
      const cur = lines[lines.length - 1], tryLine = cur ? cur + ' ' + w : w;
      if (x.measureText(tryLine).width <= maxW || !cur) lines[lines.length - 1] = tryLine; else lines.push(w);
    }
    if (lines.length > 2) { let l = lines[1] + ' ' + lines.slice(2).join(' '); while (l.length > 3 && x.measureText(l + '…').width > maxW) l = l.slice(0, -1); lines[1] = l.trimEnd() + '…'; }
    lines.slice(0, 2).forEach((l, i) => x.fillText(l, X, Y + i * lh));
  }
  const tube = { ctx: null, tex: null, clock: 0, thumbs: [], clip: '' };
  function drawTube(t) {
    const x = tube.ctx, n = CLIPS.length, idx = Math.floor(t / SLOT) % n, local = t % SLOT, clip = CLIPS[idx], PX = 20, PY = 56;
    tube.clip = clip.title;
    x.setLineDash([]); x.shadowBlur = 0; x.globalAlpha = 1; x.lineCap = 'butt';
    x.fillStyle = '#0f0f0f'; x.fillRect(0, 0, 1024, 576);
    // header: menu, site mark, search box, account
    x.fillStyle = '#e8e8e8'; for (let i = 0; i < 3; i++) x.fillRect(18, 15 + i * 7, 20, 2);
    x.fillStyle = '#27e0ff'; dot(x, 66, 23, 12);
    x.fillStyle = '#0f0f0f'; x.beginPath(); x.moveTo(62, 16); x.lineTo(73, 23); x.lineTo(62, 30); x.fill();
    x.fillStyle = '#fff'; x.font = '700 19px "Segoe UI", sans-serif'; x.textAlign = 'left'; x.fillText('RiceTube', 86, 30);
    x.strokeStyle = '#3a3a3a'; x.lineWidth = 1.5; rr(x, 330, 8, 360, 30, 15); x.stroke();
    x.fillStyle = '#8a8a8a'; x.font = '15px "Segoe UI", sans-serif'; x.fillText('Search', 348, 28);
    x.fillStyle = '#ff3d81'; dot(x, 992, 23, 13);
    x.fillStyle = '#fff'; x.font = '700 13px "Segoe UI", sans-serif'; x.textAlign = 'center'; x.fillText('S', 992, 28);
    // the picture
    x.save(); rr(x, PX, PY, VW, VH, 10); x.clip(); x.translate(PX, PY);
    clip.draw(x, local + idx * 40);
    x.restore();
    x.save(); rr(x, PX, PY, VW, VH, 10); x.clip();
    x.fillStyle = vgrad(x, PY + VH - 70, PY + VH, [[0, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.75)']]); x.fillRect(PX, PY + VH - 70, VW, 70);
    const now = clip.at + local, frac = now / clip.len, barY = PY + VH - 34;
    x.fillStyle = 'rgba(255,255,255,0.25)'; x.fillRect(PX + 14, barY, VW - 28, 4);
    x.fillStyle = 'rgba(255,255,255,0.45)'; x.fillRect(PX + 14, barY, (VW - 28) * Math.min(1, frac + 0.07), 4);
    x.fillStyle = '#ff2d2d'; x.fillRect(PX + 14, barY, (VW - 28) * frac, 4); dot(x, PX + 14 + (VW - 28) * frac, barY + 2, 6);
    x.fillStyle = '#fff'; x.fillRect(PX + 18, barY + 13, 4, 14); x.fillRect(PX + 26, barY + 13, 4, 14); // pause glyph
    x.font = '600 13px "Segoe UI", sans-serif'; x.textAlign = 'left'; x.fillText(`${clock2(now)} / ${clock2(clip.len)}`, PX + 44, barY + 25);
    if (local < 0.8) { // the new clip buffers for a moment, then fades in
      x.fillStyle = `rgba(0,0,0,${local < 0.45 ? 1 : 1 - (local - 0.45) / 0.35})`; x.fillRect(PX, PY, VW, VH);
      if (local < 0.5) { x.strokeStyle = '#fff'; x.lineWidth = 4; x.beginPath(); x.arc(PX + VW / 2, PY + VH / 2, 20, t * 9, t * 9 + 4.4); x.stroke(); }
    }
    x.restore();
    // title, channel, buttons
    x.fillStyle = '#fff'; x.textAlign = 'left'; x.font = '700 21px "Segoe UI", sans-serif'; x.fillText(clip.title, PX, 458, VW);
    x.fillStyle = clip.col; dot(x, PX + 18, 498, 17);
    x.fillStyle = '#fff'; x.font = '700 15px "Segoe UI", sans-serif'; x.textAlign = 'center'; x.fillText(clip.ch[0], PX + 18, 503);
    x.textAlign = 'left'; x.font = '600 15px "Segoe UI", sans-serif'; x.fillText(clip.ch, PX + 46, 495);
    x.fillStyle = '#9a9a9a'; x.font = '12px "Segoe UI", sans-serif'; x.fillText(clip.subs, PX + 46, 512);
    x.fillStyle = '#f1f1f1'; rr(x, PX + 200, 482, 104, 32, 16); x.fill();
    x.fillStyle = '#0f0f0f'; x.font = '700 14px "Segoe UI", sans-serif'; x.textAlign = 'center'; x.fillText('Subscribe', PX + 252, 503);
    x.fillStyle = '#272727'; rr(x, PX + 470, 482, 88, 32, 16); x.fill(); rr(x, PX + 568, 482, 92, 32, 16); x.fill();
    x.fillStyle = '#f1f1f1'; x.font = '600 14px "Segoe UI", sans-serif'; x.fillText('▲  12K', PX + 514, 503); x.fillText('Share', PX + 614, 503);
    x.fillStyle = '#9a9a9a'; x.textAlign = 'left'; x.font = '13px "Segoe UI", sans-serif'; x.fillText(`${clip.views}  ·  2 days ago`, PX, 546);
    // "Up next"
    const hover = local > SLOT - 1.0;
    for (let j = 0; j < 4; j++) {
      const ci = (idx + 1 + j) % n, c = CLIPS[ci], Y = 58 + j * 98;
      if (j === 0 && hover) { x.fillStyle = '#272727'; rr(x, 694, Y - 6, 322, 96, 10); x.fill(); }
      x.save(); rr(x, 700, Y, 150, 84, 8); x.clip(); x.drawImage(tube.thumbs[ci], 700, Y, 150, 84); x.restore();
      x.fillStyle = 'rgba(0,0,0,0.8)'; rr(x, 808, Y + 62, 38, 18, 4); x.fill();
      x.fillStyle = '#fff'; x.font = '600 11px "Segoe UI", sans-serif'; x.textAlign = 'center'; x.fillText(clock2(c.len), 827, Y + 75);
      x.textAlign = 'left'; x.font = '600 14px "Segoe UI", sans-serif'; wrap2(x, c.title, 860, Y + 16, 150, 18);
      x.fillStyle = '#9a9a9a'; x.font = '12px "Segoe UI", sans-serif'; x.fillText(c.ch, 860, Y + 58); x.fillText(c.views, 860, Y + 75);
    }
    // the pointer: rests on the player, glides to the first "Up next" row and clicks it just before the switch
    const rest = [470, 300], go = [776, 104];
    const e = (v) => { v = Math.min(1, Math.max(0, v)); return v * v * (3 - 2 * v); };
    const k = local < 1.4 ? 1 - e((local - 0.3) / 1.1) : e((local - (SLOT - 1.9)) / 1.1);
    const mx = rest[0] + (go[0] - rest[0]) * k, my = rest[1] + (go[1] - rest[1]) * k + 26 * Math.sin(Math.PI * k);
    const click = local > SLOT - 0.5 ? (local - (SLOT - 0.5)) / 0.5 : local < 0.3 ? 1 : -1;
    if (click >= 0 && click < 1) { x.strokeStyle = `rgba(255,255,255,${0.8 * (1 - click)})`; x.lineWidth = 3; x.beginPath(); x.arc(mx, my, 6 + 26 * click, 0, 7); x.stroke(); }
    x.fillStyle = '#fff'; x.strokeStyle = '#000'; x.lineWidth = 1.5; x.beginPath();
    x.moveTo(mx, my); x.lineTo(mx, my + 20); x.lineTo(mx + 5.5, my + 15.5); x.lineTo(mx + 9.5, my + 23); x.lineTo(mx + 12.5, my + 21.5); x.lineTo(mx + 8.5, my + 14); x.lineTo(mx + 15, my + 14); x.closePath(); x.fill(); x.stroke();
    tube.tex.needsUpdate = true;
  }
  if (tradeMesh) {
    const [tc, tx] = makeCanvas(1024, 576);
    tube.ctx = tx;
    tube.tex = new THREE.CanvasTexture(tc);
    tube.tex.flipY = false; tube.tex.colorSpace = THREE.SRGBColorSpace; tube.tex.anisotropy = maxAniso;
    tradeMesh.material = new THREE.MeshBasicMaterial({ map: tube.tex, toneMapped: false });
    tradeMesh.material.color.setScalar(0.95);
    tube.thumbs = CLIPS.map((c, i) => { // one still of each clip for the "Up next" list
      const [hc, hx] = makeCanvas(300, 169);
      hx.scale(300 / VW, 300 / VW); c.draw(hx, 2.2 + i * 40);
      return hc;
    });
    drawTube(reduceMotion ? 3 : 0.9);
  }

  // souvenir licence plates under the ceiling: nine original designs drawn into one 3 x 3 sheet (1024 x 512 each).
  // Every plate is drawn in a 512 x 256 space at double scale, with pressed-metal touches: a raised rim, embossed
  // lettering (a light edge above, a shadow below), bolt slots and a soft sheen.
  if (platesMeshes.length) {
    const CW = 512, CH = 256, [pc, px] = makeCanvas(CW * 6, CH * 6);
    const IMPACT = 'Impact, "Arial Black", sans-serif';
    const cell = (i, fn) => { px.save(); px.translate((i % 3) * CW * 2, Math.floor(i / 3) * CH * 2); px.scale(2, 2); px.beginPath(); px.rect(0, 0, CW, CH); px.clip(); fn(px); finishPlate(px); px.restore(); };
    const blank = (x, bg, edge) => { x.fillStyle = edge; x.fillRect(0, 0, CW, CH); x.fillStyle = bg; rr(x, 9, 9, CW - 18, CH - 18, 22); x.fill(); };
    const finishPlate = (x) => { // raised rim, bolt slots, sheen: the same pressed-metal finish on every plate
      x.lineWidth = 3; x.strokeStyle = 'rgba(255,255,255,0.55)'; rr(x, 14, 14, CW - 28, CH - 28, 18); x.stroke();
      x.lineWidth = 1.5; x.strokeStyle = 'rgba(0,0,0,0.28)'; rr(x, 16.5, 16.5, CW - 33, CH - 33, 16); x.stroke();
      [[150, 20], [CW - 150, 20], [150, CH - 20], [CW - 150, CH - 20]].forEach(([a, b]) => {
        x.fillStyle = 'rgba(0,0,0,0.5)'; rr(x, a - 13, b - 4.5, 26, 9, 4.5); x.fill();
        x.fillStyle = 'rgba(255,255,255,0.35)'; rr(x, a - 12, b + 3.5, 24, 1.5, 0.7); x.fill();
      });
      const g = x.createLinearGradient(0, 0, CW, CH);
      g.addColorStop(0, 'rgba(255,255,255,0.16)'); g.addColorStop(0.35, 'rgba(255,255,255,0)'); g.addColorStop(0.62, 'rgba(255,255,255,0.08)'); g.addColorStop(1, 'rgba(0,0,0,0.1)');
      x.fillStyle = g; x.fillRect(0, 0, CW, CH);
    };
    const label = (x, s, X, Y, font, fill, stroke, sw = 8, emboss = true) => {
      x.font = font; x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineJoin = 'round';
      if (stroke) { x.lineWidth = sw; x.strokeStyle = stroke; x.strokeText(s, X, Y); }
      if (emboss) { x.fillStyle = 'rgba(0,0,0,0.35)'; x.fillText(s, X + 1.2, Y + 2); x.fillStyle = 'rgba(255,255,255,0.5)'; x.fillText(s, X - 0.8, Y - 1.2); }
      x.fillStyle = fill; x.fillText(s, X, Y);
    };
    const star = (x, X, Y, R) => { x.beginPath(); for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + (k * Math.PI) / 5, r = k % 2 ? R * 0.4 : R; x.lineTo(X + r * Math.cos(a), Y + r * Math.sin(a)); } x.closePath(); x.fill(); };
    const poly = (x, pts) => { x.beginPath(); pts.forEach(([a, b], i) => (i ? x.lineTo(a, b) : x.moveTo(a, b))); x.closePath(); x.fill(); };
    const palm = (x, X, Y, h, c) => { // a small palm tree
      x.strokeStyle = c; x.lineWidth = 4; x.lineCap = 'round'; x.beginPath(); x.moveTo(X, Y); x.quadraticCurveTo(X + h * 0.12, Y - h * 0.5, X + h * 0.04, Y - h); x.stroke();
      x.lineWidth = 3; for (let k = 0; k < 7; k++) { const a = -Math.PI + (k * Math.PI) / 6; x.beginPath(); x.moveTo(X + h * 0.04, Y - h); x.quadraticCurveTo(X + h * 0.04 + Math.cos(a) * h * 0.3, Y - h - h * 0.22 + Math.sin(a) * 4, X + h * 0.04 + Math.cos(a) * h * 0.46, Y - h + h * 0.12 * Math.abs(Math.cos(a)) + 6); x.stroke(); }
      x.lineCap = 'butt';
    };
    cell(0, (x) => { // Canmore, Alberta: snow-capped range, wild rose, registration stickers
      blank(x, '#f7f5ef', '#c4c1b8');
      x.fillStyle = '#b3c3d6'; poly(x, [[12, 206], [70, 138], [112, 170], [170, 104], [222, 168], [262, 122], [318, 176], [372, 108], [428, 172], [470, 140], [500, 160], [500, 206]]);
      x.fillStyle = '#ffffff'; [[170, 104, 26], [262, 122, 18], [372, 108, 24], [70, 138, 16]].forEach(([a, b, w]) => poly(x, [[a, b], [a - w * 0.55, b + w * 0.75], [a - w * 0.15, b + w * 0.55], [a + w * 0.1, b + w * 0.8], [a + w * 0.5, b + w * 0.7]]));
      x.fillStyle = '#7f9a86'; for (let i = 0; i < 26; i++) poly(x, [[20 + i * 18.6, 206], [27 + i * 18.6, 184 - (i % 3) * 5], [34 + i * 18.6, 206]]);
      label(x, 'Alberta', CW / 2, 46, 'italic 700 40px Georgia, serif', '#1f4fa0', null, 0, false);
      x.strokeStyle = '#1f4fa0'; x.lineWidth = 2.5; x.beginPath(); x.moveTo(184, 66); x.quadraticCurveTo(256, 76, 330, 62); x.stroke();
      label(x, 'CANMORE', CW / 2, 134, `96px ${IMPACT}`, '#c8242b', '#f7f5ef', 9);
      label(x, 'Wild Rose Country', CW / 2, 228, '700 22px Georgia, serif', '#c8242b', '#f7f5ef', 5, false);
      x.fillStyle = '#e8507a'; for (let k = 0; k < 5; k++) dot(x, 52 + 11 * Math.cos(k * 1.257), 226 + 11 * Math.sin(k * 1.257), 8); x.fillStyle = '#f7d54a'; dot(x, 52, 226, 5);
      x.fillStyle = '#1f4fa0'; rr(x, 430, 212, 50, 28, 4); x.fill(); label(x, '26', 455, 227, '800 18px "Segoe UI", sans-serif', '#fff', null, 0, false);
    });
    cell(1, (x) => { // Miami Beach, Florida: orange with blossom, palms
      blank(x, '#fbfaf5', '#c4c1b8');
      palm(x, 52, 214, 120, '#2d7a3a'); palm(x, 462, 214, 120, '#2d7a3a');
      x.fillStyle = '#f39a1e'; dot(x, CW / 2, 132, 48); x.fillStyle = '#f7b84a'; dot(x, CW / 2 - 14, 118, 16);
      x.fillStyle = '#3d8b37'; [[24, 84, -0.6], [-6, 80, 0.5]].forEach(([dx, y, a]) => { x.beginPath(); x.ellipse(CW / 2 + dx, y, 24, 9, a, 0, 7); x.fill(); });
      x.fillStyle = '#fff'; for (let k = 0; k < 5; k++) dot(x, CW / 2 + 40 + 7 * Math.cos(k * 1.257), 96 + 7 * Math.sin(k * 1.257), 5); x.fillStyle = '#f7d54a'; dot(x, CW / 2 + 40, 96, 3);
      label(x, 'FLORIDA', CW / 2, 44, '800 34px Georgia, serif', '#2d7a3a', '#fbfaf5', 5, false);
      label(x, 'MIAMI   BEACH', CW / 2, 136, `80px ${IMPACT}`, '#15151a', '#fbfaf5', 8);
      label(x, 'SUNSHINE STATE', CW / 2, 226, '700 22px "Segoe UI", sans-serif', '#15151a', null, 0, false);
    });
    cell(2, (x) => { // Japan: mountain, tiered castle, blossom branch, cranes
      x.fillStyle = vgrad(x, 0, CH, [[0, '#3f9fe6'], [1, '#c8eafc']]); x.fillRect(0, 0, CW, CH);
      x.fillStyle = '#e8322e'; dot(x, 420, 74, 44);
      x.fillStyle = '#6f8fc0'; poly(x, [[250, 236], [360, 96], [392, 96], [512, 236]]); x.fillStyle = '#fff'; poly(x, [[360, 96], [392, 96], [414, 122], [398, 116], [384, 128], [370, 114], [350, 126], [344, 116]]);
      x.fillStyle = '#e9e6dc'; x.fillRect(84, 150, 170, 86); x.fillRect(108, 104, 122, 40); x.fillRect(130, 62, 78, 36);
      x.fillStyle = '#7d8590'; poly(x, [[70, 236], [84, 196], [254, 196], [268, 236]]);
      x.fillStyle = '#22324a'; [[62, 150, 214], [88, 104, 162], [112, 62, 114]].forEach(([l, y, w]) => poly(x, [[l - 6, y + 10], [l + 12, y - 2], [l + 26, y - 14], [l + w - 26, y - 14], [l + w - 12, y - 2], [l + w + 6, y + 10]]));
      poly(x, [[150, 50], [169, 30], [188, 50]]);
      x.fillStyle = '#22324a'; for (let i = 0; i < 5; i++) { x.fillRect(100 + i * 32, 166, 10, 16); if (i < 3) x.fillRect(128 + i * 32, 116, 10, 14); }
      x.fillStyle = '#f2c94c'; dot(x, 169, 30, 4);
      x.strokeStyle = '#5a3a2a'; x.lineWidth = 5; x.lineCap = 'round'; x.beginPath(); x.moveTo(0, 30); x.quadraticCurveTo(60, 44, 118, 20); x.moveTo(50, 40); x.quadraticCurveTo(70, 66, 96, 70); x.stroke(); x.lineCap = 'butt';
      for (let i = 0; i < 22; i++) { const bx2 = 6 + ((i * 47) % 122), by2 = 14 + ((i * 29) % 62); x.fillStyle = i % 3 ? '#f8b6cf' : '#fbd3e2'; for (let k = 0; k < 5; k++) dot(x, bx2 + 5 * Math.cos(k * 1.257 + i), by2 + 5 * Math.sin(k * 1.257 + i), 3.6); x.fillStyle = '#e8507a'; dot(x, bx2, by2, 1.8); }
      x.fillStyle = '#f8b6cf'; for (let i = 0; i < 14; i++) dot(x, 280 + ((i * 53) % 220), 190 + ((i * 37) % 56), 3 + (i % 3));
      x.strokeStyle = '#fff'; x.lineWidth = 3; [[300, 44, 16], [334, 62, 12]].forEach(([a, b, w]) => { x.beginPath(); x.moveTo(a - w, b - 4); x.quadraticCurveTo(a - w / 2, b - 12, a, b); x.quadraticCurveTo(a + w / 2, b - 12, a + w, b - 4); x.stroke(); });
      label(x, 'JAPAN', CW / 2 + 60, 150, `104px ${IMPACT}`, '#d8221f', '#fff', 10);
    });
    cell(3, (x) => { // Barcelona: Euro band, spires with cranes of detail, broken-tile mosaic
      blank(x, '#f3d98c', '#b58a3c');
      const tiles = ['#e2572b', '#2a7bbf', '#f0b429', '#3aa37a', '#8b4fb8', '#f4f1e8', '#e8507a'];
      for (let i = 0; i < 44; i++) { x.fillStyle = tiles[(i * 5) % 7]; x.save(); x.translate(86 + i * 9.6, 214 + ((i * 7) % 5) * 5); x.rotate(i * 1.3); x.fillRect(-6, -5, 12, 10); x.restore(); }
      x.fillStyle = '#8a6238'; [[232, 74, 20], [272, 54, 22], [316, 58, 22], [356, 80, 20]].forEach(([cx2, top, w]) => { poly(x, [[cx2 - w / 2, 196], [cx2 - w / 4, top + 30], [cx2, top], [cx2 + w / 4, top + 30], [cx2 + w / 2, 196]]); });
      x.fillStyle = '#f3d98c'; [[232, 74], [272, 54], [316, 58], [356, 80]].forEach(([cx2, top]) => { for (let k = 0; k < 6; k++) x.fillRect(cx2 - 2, top + 36 + k * 20, 4, 10); });
      x.fillStyle = '#e2572b'; [[232, 74], [272, 54], [316, 58], [356, 80]].forEach(([cx2, top]) => dot(x, cx2, top - 3, 4));
      x.fillStyle = '#8a6238'; poly(x, [[212, 196], [212, 150], [294, 124], [376, 150], [376, 196]]); x.fillStyle = '#5a3a1e'; x.beginPath(); x.arc(294, 196, 20, Math.PI, 0); x.fill(); dot(x, 294, 152, 9);
      x.fillStyle = '#3aa37a'; x.beginPath(); x.ellipse(430, 184, 44, 12, -0.2, 0, 7); x.fill(); x.fillStyle = '#f0b429'; for (let k = 0; k < 6; k++) dot(x, 398 + k * 13, 186 - k * 2.4, 3.5); // a mosaic lizard
      x.fillStyle = '#1f3f9a'; rr(x, 9, 9, 66, CH - 18, 20); x.fill(); x.fillRect(50, 9, 25, CH - 18);
      x.fillStyle = '#f5d000'; for (let k = 0; k < 12; k++) star(x, 42 + 21 * Math.cos((k * Math.PI) / 6), 70 + 21 * Math.sin((k * Math.PI) / 6), 4);
      label(x, 'CAT', 42, 214, '800 25px "Segoe UI", sans-serif', '#fff', null, 0, false);
      label(x, 'Barcelona', 250, 34, 'italic 700 46px Georgia, serif', '#5a2a16', '#f3d98c', 6);
    });
    cell(4, (x) => { // Pura Vida, Costa Rica: sea turtles, waves, palm fronds
      x.fillStyle = '#0b3a6e'; x.fillRect(0, 0, CW, CH);
      x.fillStyle = vgrad(x, 0, CH, [[0, '#2cc7d6'], [1, '#0a62a0']]); rr(x, 9, 9, CW - 18, CH - 18, 22); x.fill();
      x.strokeStyle = 'rgba(255,255,255,0.22)'; x.lineWidth = 3; for (let i = 0; i < 6; i++) { x.beginPath(); for (let k = 0; k <= 32; k++) x.lineTo(k * 16, 36 + i * 38 + 7 * Math.sin(k * 0.6 + i * 1.7)); x.stroke(); }
      [[76, 196, 0.3, 1], [436, 58, -0.4, 0.85], [440, 202, 0.2, 0.9]].forEach(([tx, ty, a, sc]) => {
        x.save(); x.translate(tx, ty); x.rotate(a); x.scale(sc, sc);
        x.fillStyle = '#2f7d4b'; [[-22, -16], [22, -16], [-22, 16], [22, 16]].forEach(([fx2, fy2]) => { x.beginPath(); x.ellipse(fx2, fy2, 14, 6, fx2 * fy2 > 0 ? 0.7 : -0.7, 0, 7); x.fill(); }); dot(x, 33, 0, 10); poly(x, [[-28, -4], [-38, 0], [-28, 4]]);
        x.fillStyle = '#4aa868'; x.beginPath(); x.ellipse(0, 0, 28, 20, 0, 0, 7); x.fill();
        x.strokeStyle = '#1f5a36'; x.lineWidth = 2; x.beginPath(); x.ellipse(0, 0, 14, 9, 0, 0, 7); x.stroke();
        for (let k = 0; k < 6; k++) { const an = (k * Math.PI) / 3; x.beginPath(); x.moveTo(14 * Math.cos(an), 9 * Math.sin(an)); x.lineTo(27 * Math.cos(an), 19 * Math.sin(an)); x.stroke(); }
        x.fillStyle = '#0b2a1a'; dot(x, 37, -3, 1.6);
        x.restore();
      });
      label(x, 'COSTA RICA', CW / 2, 40, '800 28px "Segoe UI", sans-serif', '#fff', '#0b3a6e', 5, false);
      label(x, 'PURA  VIDA', CW / 2, 130, `98px ${IMPACT}`, '#fff', '#0b3a6e', 11);
      label(x, 'CENTROAMERICA', CW / 2, 222, '800 24px "Segoe UI", sans-serif', '#fff', '#0b3a6e', 5, false);
    });
    cell(5, (x) => { // Monaco, Monte-Carlo: racing car, flags, lozenge shield, palms
      blank(x, '#111114', '#c9a24a');
      for (let i = 0; i < 5; i++) for (let j = 0; j < 3; j++) { x.fillStyle = (i + j) % 2 ? '#111114' : '#f1f1f1'; x.fillRect(22 + i * 17, 26 + j * 17, 17, 17); x.fillRect(CW - 107 + i * 17, 26 + j * 17, 17, 17); }
      palm(x, 40, 226, 96, '#e3bd5a'); palm(x, 476, 226, 96, '#e3bd5a');
      label(x, 'MONACO', CW / 2, 42, `50px ${IMPACT}`, '#e3bd5a');
      label(x, 'MONTE-CARLO', CW / 2, 88, '800 23px "Segoe UI", sans-serif', '#f1f1f1', null, 0, false);
      x.fillStyle = '#f1f1f1'; poly(x, [[240, 104], [272, 104], [272, 126], [256, 138], [240, 126]]); x.fillStyle = '#d8221f'; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if ((i + j) % 2) poly(x, [[244 + i * 8, 108 + j * 7], [248 + i * 8, 104.5 + j * 7], [252 + i * 8, 108 + j * 7], [248 + i * 8, 111.5 + j * 7]]);
      x.fillStyle = '#19191d'; [152, 372].forEach((wx) => dot(x, wx, 196, 30)); x.fillStyle = '#6b6b73'; [152, 372].forEach((wx) => dot(x, wx, 196, 14)); x.fillStyle = '#e3bd5a'; [152, 372].forEach((wx) => dot(x, wx, 196, 5));
      x.fillStyle = '#d8221f'; rr(x, 118, 160, 286, 30, 13); x.fill(); poly(x, [[400, 160], [476, 184], [476, 192], [400, 190]]);
      rr(x, 206, 136, 84, 36, 14); x.fill(); x.fillRect(76, 128, 16, 58); rr(x, 66, 122, 50, 14, 4); x.fill(); rr(x, 452, 180, 40, 14, 4); x.fill();
      x.fillStyle = '#f1f1f1'; x.fillRect(296, 168, 70, 7); x.fillStyle = '#f2c94c'; dot(x, 250, 148, 12); x.fillStyle = '#19191d'; x.fillRect(240, 146, 20, 5);
      label(x, '16', 190, 176, '800 18px "Segoe UI", sans-serif', '#fff', null, 0, false);
    });
    cell(6, (x) => { // New York: suspension bridge, skyline with lit windows, statue
      blank(x, '#e8edf3', '#aab2bd');
      x.fillStyle = '#c9d6e6'; x.fillRect(12, 196, CW - 24, 40);
      x.strokeStyle = '#7d8aa0'; x.lineWidth = 3; x.beginPath(); x.moveTo(16, 150); x.quadraticCurveTo(48, 168, 80, 118); x.quadraticCurveTo(140, 208, 200, 118); x.quadraticCurveTo(232, 168, 262, 156); x.stroke();
      x.lineWidth = 1; for (let k = 0; k < 14; k++) { const u = k / 13, cx2 = 80 + u * 120, cy2 = 118 + 90 * 4 * u * (1 - u) * 0.5; x.beginPath(); x.moveTo(cx2, cy2); x.lineTo(cx2, 198); x.stroke(); }
      x.fillStyle = '#6a7890'; [74, 194].forEach((tx) => { x.fillRect(tx, 112, 14, 100); x.fillStyle = '#e8edf3'; x.beginPath(); x.moveTo(tx + 3, 198); x.lineTo(tx + 3, 170); x.quadraticCurveTo(tx + 7, 160, tx + 11, 170); x.lineTo(tx + 11, 198); x.fill(); x.fillStyle = '#6a7890'; });
      x.fillRect(12, 196, 256, 7);
      const bl = [[274, 128, 24], [300, 96, 28], [330, 136, 22], [354, 58, 30], [386, 112, 28], [416, 146, 24]];
      bl.forEach(([l, top, w], i) => { x.fillStyle = i % 2 ? '#4d5b73' : '#5d6c86'; x.fillRect(l, top, w, 212 - top); x.fillStyle = '#f7e9a8'; for (let r = 0; r < Math.floor((204 - top) / 12); r++) for (let c = 0; c < Math.floor(w / 8); c++) if ((r * 3 + c * 5 + i) % 4) x.fillRect(l + 3 + c * 8, top + 6 + r * 12, 3, 5); });
      x.fillStyle = '#4d5b73'; poly(x, [[360, 58], [364, 40], [367, 40], [369, 14], [371, 40], [374, 40], [378, 58]]);
      x.fillStyle = '#5f9c8a'; x.fillRect(458, 176, 26, 36); poly(x, [[462, 176], [466, 132], [478, 132], [482, 176]]); dot(x, 472, 124, 9); x.fillRect(481, 92, 5, 40);
      for (let k = 0; k < 5; k++) poly(x, [[472 + 14 * Math.cos(-2.5 + k * 0.45), 124 + 14 * Math.sin(-2.5 + k * 0.45)], [470, 120], [474, 120]]);
      x.fillStyle = '#f0b429'; poly(x, [[478, 92], [483.5, 78], [489, 92]]);
      label(x, 'NEW YORK', 150, 60, `58px ${IMPACT}`, '#27334a', '#e8edf3', 6);
      label(x, 'EMPIRE STATE', CW / 2, 226, '700 20px "Segoe UI", sans-serif', '#27334a', null, 0, false);
    });
    cell(7, (x) => { // Korea: taegeuk with trigram bars, hanbok figure, temple roof
      blank(x, '#1f6a4c', '#103a2a');
      x.fillStyle = '#b3202a'; rr(x, 9, 9, CW - 18, 150, 22); x.fill(); x.fillRect(9, 100, CW - 18, 62);
      x.fillStyle = '#f4f1e8'; dot(x, 78, 84, 52);
      x.save(); x.translate(78, 84); x.rotate(-0.55);
      x.fillStyle = '#cd2e3a'; x.beginPath(); x.arc(0, 0, 34, Math.PI, 0); x.fill(); x.fillStyle = '#0047a0'; x.beginPath(); x.arc(0, 0, 34, 0, Math.PI); x.fill();
      x.fillStyle = '#cd2e3a'; dot(x, -17, 0, 17); x.fillStyle = '#0047a0'; dot(x, 17, 0, 17);
      x.fillStyle = '#15151a'; [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy], q) => { x.save(); x.rotate(Math.atan2(sy, sx)); for (let k = 0; k < 3; k++) { if ((q + k) % 3 === 1) { x.fillRect(40 + k * 4.2, -9, 2.8, 8); x.fillRect(40 + k * 4.2, 1, 2.8, 8); } else x.fillRect(40 + k * 4.2, -9, 2.8, 18); } x.restore(); });
      x.restore();
      label(x, 'I', 158, 86, `76px ${IMPACT}`, '#fff');
      x.fillStyle = '#ff5c7a'; dot(x, 196, 76, 16); dot(x, 224, 76, 16); poly(x, [[181, 84], [210, 116], [239, 84]]);
      label(x, 'KOREA', 350, 88, `82px ${IMPACT}`, '#fff', '#103a2a', 8);
      x.fillStyle = '#15151a'; poly(x, [[420, 196], [434, 180], [452, 172], [486, 172], [504, 180], [504, 196]]); x.fillStyle = '#c9a24a'; x.fillRect(440, 196, 58, 6); x.fillStyle = '#b3202a'; for (let k = 0; k < 4; k++) x.fillRect(444 + k * 15, 202, 6, 34); // a temple roof and pillars
      x.fillStyle = '#f2c9a0'; dot(x, 36, 184, 9); x.fillStyle = '#15151a'; x.beginPath(); x.arc(36, 182, 10, Math.PI, 0); x.fill(); x.fillStyle = '#f7d54a'; poly(x, [[26, 196], [46, 196], [50, 210], [22, 210]]); x.fillStyle = '#e8507a'; poly(x, [[22, 210], [50, 210], [62, 240], [10, 240]]); // a figure in traditional dress
      label(x, 'the beauty of Korea', CW / 2 + 6, 206, 'italic 600 30px Georgia, serif', '#f4f1e8', null, 0, false);
    });
    cell(8, (x) => { // Puerto Rico: flag, rock-carving frog and sun
      blank(x, '#fafaf7', '#b9b9b9');
      const fx0 = 180, fy0 = 46, fw = 152, fh = 100;
      for (let i = 0; i < 5; i++) { x.fillStyle = i % 2 ? '#fff' : '#e0202a'; x.fillRect(fx0, fy0 + (i * fh) / 5, fw, fh / 5); }
      x.fillStyle = '#0a50b4'; poly(x, [[fx0, fy0], [fx0 + 72, fy0 + fh / 2], [fx0, fy0 + fh]]);
      x.fillStyle = '#fff'; star(x, fx0 + 25, fy0 + fh / 2, 17);
      x.strokeStyle = '#15151a'; x.lineWidth = 2.5; x.strokeRect(fx0, fy0, fw, fh);
      x.lineWidth = 6; x.lineCap = 'round'; x.lineJoin = 'round'; // the frog: round body with a spiral, bent legs, splayed toes
      x.beginPath(); x.arc(96, 86, 20, 0, 7); x.stroke(); x.lineWidth = 3.5; x.beginPath(); for (let k = 0; k < 40; k++) { const a = k * 0.32, r = 1 + k * 0.33; x.lineTo(96 + r * Math.cos(a), 86 + r * Math.sin(a)); } x.stroke();
      x.lineWidth = 5; x.beginPath(); x.moveTo(82, 72); x.lineTo(64, 54); x.lineTo(54, 66); x.moveTo(110, 72); x.lineTo(128, 54); x.lineTo(138, 66); x.moveTo(82, 102); x.lineTo(62, 124); x.lineTo(50, 112); x.moveTo(110, 102); x.lineTo(130, 124); x.lineTo(142, 112); x.stroke();
      x.fillStyle = '#15151a'; dot(x, 96, 58, 9);
      x.lineWidth = 5; x.beginPath(); x.arc(420, 92, 28, 0, 7); x.stroke(); // the sun: a face ringed with rays
      for (let k = 0; k < 12; k++) { const a = (k * Math.PI) / 6; x.beginPath(); x.moveTo(420 + 36 * Math.cos(a), 92 + 36 * Math.sin(a)); x.lineTo(420 + (k % 2 ? 46 : 52) * Math.cos(a), 92 + (k % 2 ? 46 : 52) * Math.sin(a)); x.stroke(); }
      dot(x, 409, 84, 4.5); dot(x, 431, 84, 4.5); x.lineWidth = 4; x.beginPath(); x.arc(420, 96, 13, 0.25, Math.PI - 0.25); x.stroke(); x.lineCap = 'butt';
      label(x, 'ISLA DEL ENCANTO', CW / 2, 30, '700 17px "Segoe UI", sans-serif', '#15151a', null, 0, false);
      label(x, 'PUERTO  RICO', CW / 2, 200, '800 46px "Courier New", monospace', '#15151a', '#fafaf7', 5);
    });
    const pt = new THREE.CanvasTexture(pc);
    pt.flipY = false; pt.colorSpace = THREE.SRGBColorSpace; pt.anisotropy = maxAniso;
    // glossy enamel: the print glows at a fixed level (it is not in the baked light), and the room reflects in it
    const plateMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: pt, emissiveIntensity: PLATE_LEVEL[0], roughness: 0.28, metalness: 0, envMapIntensity: 0.9 });
    platesMeshes.forEach((m) => { m.material = plateMat; });
  }

  // ------------------------------------------------------------------ the cat and the dog
  // Each animal (assets/pets.glb, made by blender/build_pets.py) is one skinned mesh with a skeleton. Here it gets a
  // coat of fur (the mesh drawn again in thin layers pushed outward, each keeping only its share of the strands), is
  // walked by turning its bones, and is sent round a small map of clear floor points: it hops up onto the bed, the
  // chair, the cabinet top and the cat tower, sits or lies there for a while, and hops back down.
  // All coordinates below are Blender ones (x, y on the floor, z up), like everything else that is placed by hand.
  const DOCK = [4.05, 0.245], DOCK_OUT = [4.05, 0.95], VAC_SEAT = 0.083; // the robot vacuum's dock, the spot it backs out to, and the height of its lid
  const PARK = [2.37, 4.45], PARK_OUT = [2.37, 3.5];                      // the toy car's parking spot and where it lines up to reverse in
  let vac = null, rari = null, tank = null;                               // set up further down; the pets react to the first two
  const FLOOR = { a: [1.5, 2.2], b: [2.9, 2.5], c: [4.0, 2.75], d: [4.5, 2.2], e: [2.9, 3.7], f: [1.3, 3.6], g: [4.1, 3.6], h: [1.0, 2.45], i: [2.6, 1.6] };
  const LINKS = ['ab', 'bc', 'cd', 'ah', 'ai', 'bi', 'be', 'ef', 'eg', 'cg', 'af', 'hf'];
  const PERCH = {
    bedFoot: { p: [5.0, 4.2, 0.43], from: 'g', off: [4.3, 4.1], who: 'both' },
    bedHead: { p: [5.0, 3.52, 0.455], from: 'g', off: [4.32, 3.52], who: 'cat' },
    chair: { p: [3.3, 1.45, 0.53], from: 'i', off: [2.72, 1.62], who: 'both' },
    counter: { p: [0.27, 2.47, 0.565], from: 'h', off: [0.86, 2.47], who: 'cat' },
    tower: { p: [0.62, 4.2, 0.465], from: 'f', off: [0.85, 3.68], who: 'cat' },
  };
  const adj = {};
  LINKS.forEach(([p, q]) => { (adj[p] ??= []).push(q); (adj[q] ??= []).push(p); });
  function route(from, to) { // shortest chain of floor points
    const prev = { [from]: null }, queue = [from];
    while (queue.length) { const n = queue.shift(); if (n === to) break; for (const m of adj[n]) if (!(m in prev)) { prev[m] = n; queue.push(m); } }
    const out = []; for (let n = to; n !== from && n; n = prev[n]) out.unshift(n);
    return out;
  }
  const [blobCv, blobCx] = makeCanvas(64, 64);
  const bgr = blobCx.createRadialGradient(32, 32, 2, 32, 32, 32);
  bgr.addColorStop(0, 'rgba(0,0,0,0.6)'); bgr.addColorStop(0.6, 'rgba(0,0,0,0.28)'); bgr.addColorStop(1, 'rgba(0,0,0,0)');
  blobCx.fillStyle = bgr; blobCx.fillRect(0, 0, 64, 64);
  const blobTex = new THREE.CanvasTexture(blobCv);

  // fur: layer 0 is the skin (dark, like the roots); layers 0..1 above it keep fewer and thinner strands the further out
  const SHELLS = small || quality === 'low' || quality === 'min' ? 8 : 16;
  function furMaterial(shell, furLen, cells) {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, envMapIntensity: PET_ENV[0] });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, { uShell: { value: shell }, uFurLen: { value: furLen }, uCells: { value: cells }, uKey: petKey });
      sh.vertexShader = 'uniform float uShell; uniform float uFurLen; attribute vec2 aFur; varying vec2 vFurUv; varying float vFurF;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        float furF = aFur.x; // per-vertex fur length: full on the body, short on the face and legs, none at the eyes and nose
        vFurF = furF; vFurUv = uv;
        transformed += normalize( objectNormal ) * ( uFurLen * uShell * furF ) + vec3( 0.0, -1.0, 0.0 ) * ( uFurLen * 0.3 * uShell * uShell * furF );`);
      sh.fragmentShader = 'uniform float uShell; uniform float uCells; uniform vec3 uKey; varying vec2 vFurUv; varying float vFurF;\n' + sh.fragmentShader
        .replace('void main() {', `void main() {
        if ( uShell > 0.0 ) {
          if ( vFurF < 0.02 ) discard;
          vec2 cell = vFurUv * uCells; vec2 id = floor( cell ); vec2 f = fract( cell ) - 0.5;
          float rnd = fract( sin( dot( id, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
          float len = 0.45 + 0.55 * rnd;
          if ( uShell > len ) discard;
          vec2 jit = vec2( fract( rnd * 7.31 ), fract( rnd * 13.7 ) ) - 0.5;
          if ( length( f - jit * 0.3 ) > 0.62 * ( 1.0 - uShell / len ) + 0.06 ) discard;
        }`)
        .replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.rgb *= mix( 0.5, 1.3, uShell );')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n\tdiffuseColor.rgb *= 0.72 + 0.6 * max( dot( normal, normalize( ( viewMatrix * vec4( uKey, 0.0 ) ).xyz ) ), 0.0 );');
    };
    m.customProgramCacheKey = () => (shell > 0 ? 'fur-shell' : 'fur-skin');
    petMatList.push(m);
    return m;
  }
  const pets = [];
  const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  const AXIS_X = new THREE.Vector3(1, 0, 0), AXIS_Z = new THREE.Vector3(0, 0, 1), qTmp = new THREE.Quaternion();
  function makePet(name, o) {
    const root = petsGltf && petsGltf.scene.getObjectByName(name);
    if (!root) return null;
    const ud = root.userData, poses = JSON.parse(ud.poses), gaitDef = JSON.parse(ud.gait), furDef = JSON.parse(ud.fur);
    const bones = [];
    // Both animals use the same bone names, and the loader renames the second animal's ("thighL" becomes "thighL_1"),
    // so the poses are looked up by the name the file gave each bone, not by the name the loader ended up with.
    root.traverse((b) => { if (b.isBone) { b.userData.q0 = b.quaternion.clone(); b.userData.bone = b.userData.name || b.name.replace(/_\d+$/, ''); bones.push(b); } });
    const skins = [];
    root.traverse((m) => { if (m.isSkinnedMesh) skins.push(m); });
    skins.forEach((m) => {
      const src = m.material, md = src.userData || {};
      m.frustumCulled = false;
      m.userData.key = o.kind; hotMeshes.push(m);
      if (md.fur) {
        const geo = m.geometry; // the fur length arrives as the second UV channel
        geo.setAttribute('aFur', geo.attributes.uv1 ?? new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2).fill(1), 2));
        m.material = furMaterial(0, furDef.len, furDef.cells);
        for (let i = 1; i <= SHELLS; i++) { // the fur layers: same skeleton, drawn by the main camera only (not in the reflections)
          const sh = new THREE.SkinnedMesh(m.geometry, furMaterial(i / SHELLS, furDef.len, furDef.cells));
          sh.bind(m.skeleton, m.bindMatrix);
          sh.frustumCulled = false; sh.layers.set(1);
          m.parent.add(sh);
        }
      } else if (md.glow) m.material = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
      else {
        m.material = md.gloss
          ? new THREE.MeshPhysicalMaterial({ color: src.color.clone(), roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 2.4 })
          : new THREE.MeshStandardMaterial({ color: src.color.clone(), roughness: md.rough ?? 0.6, metalness: 0, envMapIntensity: 2.0 });
        petMatList.push(m.material);
      }
    });
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.8 }));
    blob.rotation.x = -Math.PI / 2; blob.scale.set(o.size, o.size * 1.6, 1); blob.renderOrder = 1;
    room.add(blob);
    const start = FLOOR[o.node], keys = new Set(['drop']);
    Object.values(poses).forEach((p) => Object.keys(p).forEach((k) => keys.add(k)));
    const pet = { ...o, root, bones, poses, gaitDef, blob, x: start[0], y: start[1], z: 0, heading: 0, queue: [], act: null, pose: Object.fromEntries([...keys].map((k) => [k, 0])), gait: 0, phase: 0, hop: 0, seed: Math.random() * 10 };
    pet.react = () => { if (pet.hop <= 0) { pet.hop = 1; (o.kind === 'cat' ? sound.meow : sound.woof)(); } };
    pets.push(pet);
    return pet;
  }
  function queuePerch(pet, s, dwell) { // walk to the perch's take-off point, hop up, stay a while, hop down
    s.busy = pet;
    route(pet.node, s.from).forEach((n) => pet.queue.push({ type: 'walk', to: FLOOR[n] }));
    pet.queue.push({ type: 'walk', to: s.off }, { type: 'face', to: s.p }, { type: 'wait', pose: 'crouch', dur: 0.32 }, { type: 'jump', to: s.p },
      { type: 'face', to: [2.7, 2.6] }, { type: 'wait', pose: Math.random() < 0.45 ? 'sit' : 'lie', dur: dwell },
      { type: 'face', to: s.off }, { type: 'wait', pose: 'crouch', dur: 0.32 }, { type: 'jump', to: [s.off[0], s.off[1], 0], free: s }, { type: 'walk', to: FLOOR[s.from] });
    pet.node = s.from;
  }
  function planPet(pet) {
    const other = pets.find((p) => p !== pet);
    const free = Object.values(PERCH).filter((s) => !s.busy && (s.who === 'both' || s.who === pet.kind));
    const walk = (n) => pet.queue.push({ type: 'walk', to: FLOOR[n] });
    const carOut = rari && rari.state !== 'parked';
    if (pet.kind === 'cat' && vac && vac.state === 'docked' && !vac.boarding && !vac.rider && vac.t > 3 && !carOut && Math.random() < 0.45) {
      // a ride on the robot vacuum: it stays in its dock until the cat is aboard, then carries it round the room
      vac.boarding = pet;
      route(pet.node, 'c').forEach(walk);
      pet.queue.push({ type: 'walk', to: DOCK_OUT }, { type: 'face', to: DOCK }, { type: 'wait', pose: 'crouch', dur: 0.32 }, { type: 'jump', to: [DOCK[0], DOCK[1], VAC_SEAT], board: true }, { type: 'ride' });
      pet.node = 'c';
    } else if (free.length && Math.random() < 0.62) queuePerch(pet, free[Math.floor(Math.random() * free.length)], 9 + Math.random() * 11);
    else {
      const nodes = Object.keys(FLOOR).filter((n) => n !== pet.node && n !== (other && other.node));
      const n = nodes[Math.floor(Math.random() * nodes.length)];
      route(pet.node, n).forEach(walk);
      pet.queue.push({ type: 'wait', pose: ['stand', 'sit', 'lie'][Math.floor(Math.random() * 3)], dur: 2.5 + Math.random() * 6 });
      pet.node = n;
    }
  }
  function posePet(pet, t) { // write the pet's state into its skeleton
    const { root, pose: P, gaitDef: G } = pet, g = pet.gait, rest = 1 - g, dog = pet.kind === 'dog';
    const hopY = pet.hop > 0 ? 0.07 * Math.sin(Math.PI * (1 - pet.hop)) : 0;
    root.position.set(pet.x, pet.z - P.drop + hopY + 0.006 * g * Math.abs(Math.sin(pet.phase * 2)), -pet.y);
    root.rotation.set(0, pet.heading, 0);
    for (const b of pet.bones) {
      const n = b.userData.bone, sided = /[LR]$/.test(n), base = sided ? n.slice(0, -1) : n, right = sided && n.endsWith('R');
      let a = P[n] ?? P[base] ?? 0, yaw = 0;
      if (g > 0.001 && sided) { // the walk: diagonal legs move together, and a leg folds while it swings forward
        const front = base === 'arm' || base === 'fore' || base === 'hand';
        const ph = pet.phase + (front === right ? Math.PI : 0), lift = Math.pow(Math.max(0, -Math.cos(ph)), 1.5);
        a += g * (base === 'arm' || base === 'thigh' ? G.swing * Math.sin(ph) : (G[base] ?? 0) * lift);
      }
      if (base === 'head') { a += 0.05 * g * Math.sin(pet.phase * 2) + 0.05 * rest * Math.sin(t * (dog ? 6.5 : 1.3) + pet.seed); yaw = 0.5 * rest * Math.sin(t * 0.45 + pet.seed) * Math.sin(t * 0.21 + pet.seed * 2); }
      else if (base === 'neck') a += 0.04 * g * Math.sin(pet.phase * 2 + 0.6);
      else if (base === 'spine') yaw = 0.07 * g * Math.sin(pet.phase);
      else if (base === 'hips') yaw = -0.05 * g * Math.sin(pet.phase);
      else if (n.startsWith('tail')) { const k = +n.slice(4); yaw = dog ? (0.14 + 0.2 * rest) * Math.sin(t * (6 + 5 * rest) + pet.seed - k * 0.5) : 0.16 * Math.sin(t * 1.6 + pet.seed - k * 0.7); a += 0.05 * Math.sin(t * 0.9 + k + pet.seed); }
      if (sided) yaw = (right ? 1 : -1) * (P[base + 'Out'] ?? 0); // a pose can turn a whole leg outward at its top joint ("thighOut")
      b.quaternion.copy(b.userData.q0).multiply(qTmp.setFromAxisAngle(AXIS_X, a));
      if (yaw) b.quaternion.multiply(qTmp.setFromAxisAngle(AXIS_Z, yaw));
    }
    const act = pet.act, ground = act && act.type === 'jump' && act.u !== undefined ? (act.u < 0.5 ? act.z0 : act.z1) : pet.z;
    pet.blob.position.set(pet.x, ground + 0.006, -pet.y);
    pet.blob.rotation.z = pet.heading;
    pet.blob.material.opacity = 0.8 * Math.max(0.15, 1 - (pet.z - ground) * 2.2);
  }
  function tickPet(pet, dt, t) {
    if (!pet.act) { if (!pet.queue.length) planPet(pet); pet.act = pet.queue.shift(); }
    const a = pet.act;
    let want = pet.poses.stand, moving = false, done = false;
    const turn = (h, rate) => { const d = angDiff(h, pet.heading); pet.heading += Math.sign(d) * Math.min(Math.abs(d), rate * dt); return Math.abs(d); };
    if (a.type === 'walk') {
      const dx = a.to[0] - pet.x, dy = a.to[1] - pet.y, dist = Math.hypot(dx, dy);
      if (dist < 0.03) done = true;
      else {
        moving = true;
        if (turn(Math.atan2(dx, -dy), 4.5) < 0.6) { const st = Math.min(dist, pet.speed * (pet.rush || 1) * dt); pet.x += (dx / dist) * st; pet.y += (dy / dist) * st; pet.phase += (st * Math.PI * 2) / pet.stride; }
        else pet.phase += dt * 7; // stepping round on the spot
      }
    } else if (a.type === 'face') {
      moving = true; pet.phase += dt * 6;
      if (turn(Math.atan2(a.to[0] - pet.x, -(a.to[1] - pet.y)), 4) < 0.05) done = true;
    } else if (a.type === 'wait') {
      want = pet.poses[a.pose]; a.t = (a.t || 0) + dt;
      if (a.bark && !a.barked && a.t > 0.7) { a.barked = true; pet.react(); }
      if (a.t > a.dur) done = true;
    } else if (a.type === 'jump') {
      if (a.u === undefined) { Object.assign(a, { u: 0, x0: pet.x, y0: pet.y, z0: pet.z, z1: a.to[2] }); a.len = Math.hypot(a.to[0] - pet.x, a.to[1] - pet.y); a.dur = 0.42 + 0.28 * a.len; a.h = 0.16 + 0.3 * Math.abs(a.z1 - a.z0); }
      a.u = Math.min(1, a.u + dt / a.dur);
      const u = a.u;
      pet.x = a.x0 + (a.to[0] - a.x0) * u; pet.y = a.y0 + (a.to[1] - a.y0) * u;
      pet.z = a.z0 + (a.z1 - a.z0) * u + 4 * a.h * u * (1 - u);
      want = pet.poses.air;
      if (u >= 1) {
        done = true; pet.z = a.z1; pet.rush = 1;
        if (a.free) a.free.busy = null;
        if (a.board && vac) { vac.rider = pet; vac.boarding = null; vac.t = Math.max(vac.t, vac.wait - 1.5); } // aboard: the vacuum sets off shortly
      }
    } else if (a.type === 'ride') { // sitting on the robot vacuum, carried wherever it goes, until it stops to let the cat off
      want = pet.poses.sit;
      if (!vac || vac.rider !== pet) done = true;
      else {
        pet.x = vac.x; pet.y = vac.y; pet.z = VAC_SEAT; pet.heading = vac.heading;
        if (vac.state === 'unload') {
          done = true; vac.rider = null;
          const m = adj[vac.node][Math.floor(Math.random() * adj[vac.node].length)], d = Math.hypot(FLOOR[m][0] - vac.x, FLOOR[m][1] - vac.y) || 1;
          const off = [vac.x + ((FLOOR[m][0] - vac.x) / d) * 0.5, vac.y + ((FLOOR[m][1] - vac.y) / d) * 0.5];
          pet.queue.unshift({ type: 'face', to: off }, { type: 'wait', pose: 'crouch', dur: 0.3 }, { type: 'jump', to: [off[0], off[1], 0] }, { type: 'walk', to: FLOOR[m] });
          pet.node = m;
        }
      }
    } else if (a.type === 'chase') { // the dog runs after the toy car, just inside its lap; once the car has parked it trots over, sits and barks at it
      const run = rari && rari.state === 'run';
      let tx = FLOOR.e[0], ty = FLOOR.e[1], keep = 0.05, sp = 0.85;
      if (run) { // it runs beside the car's tail, on the side nearer the middle of the room. Never in front: the car stops for whatever is in its way, and the two would stand there nose to nose
        const fx = Math.sin(rari.heading), fy = -Math.cos(rari.heading), side = (LAP_MID[0] - rari.x) * -fy + (LAP_MID[1] - rari.y) * fx < 0 ? -1 : 1;
        tx = rari.x - fy * side * 0.42 - fx * 0.12; ty = rari.y + fx * side * 0.42 - fy * 0.12; keep = 0.2; sp = 1.3;
      }
      const dx = tx - pet.x, dy = ty - pet.y, dist = Math.hypot(dx, dy);
      if (dist > keep) {
        moving = true;
        if (turn(Math.atan2(dx, -dy), 8) < 1.0) { const st = Math.min(dist, sp * dt); pet.x += (dx / dist) * st; pet.y += (dy / dist) * st; pet.phase += (st * Math.PI * 2) / (pet.stride * 1.45); }
        else pet.phase += dt * 9;
      } else if (run) turn(Math.atan2(rari.x - pet.x, -(rari.y - pet.y)), 6);
      else { done = true; pet.node = 'e'; pet.queue.push({ type: 'face', to: PARK }, { type: 'wait', pose: 'sit', dur: 4, bark: true }); }
    }
    const k = 1 - Math.exp(-dt * 8);
    for (const key in pet.pose) pet.pose[key] += ((want[key] ?? 0) - pet.pose[key]) * k;
    pet.gait += ((moving ? 1 : 0) - pet.gait) * Math.min(1, dt * 8);
    if (pet.hop > 0) pet.hop = Math.max(0, pet.hop - dt * 2.4);
    if (done) pet.act = null;
    posePet(pet, t);
  }
  makePet('Cat', { kind: 'cat', node: 'a', speed: 0.55, stride: 0.36, size: 0.3 });
  makePet('Dog', { kind: 'dog', node: 'c', speed: 0.7, stride: 0.5, size: 0.44 });
  if (reduceMotion) { // no roaming: the cat naps on its tower and the dog on the bed
    pets.forEach((pet) => {
      const s = pet.kind === 'cat' ? PERCH.tower : PERCH.bedFoot;
      Object.assign(pet, { x: s.p[0], y: s.p[1], z: s.p[2], heading: 2.4 });
      for (const key in pet.pose) pet.pose[key] = pet.poses.lie[key] ?? 0;
      posePet(pet, 0);
    });
  } else pets.forEach((pet) => posePet(pet, 0));
  const towerPom = N('Tower_Pom'), towerBall = N('Tower_Ball');

  // ------------------------------------------------------------------ robot vacuum, toy car, aquarium
  // assets/toys.glb (made by blender/build_toys.py) holds the things that move by themselves. Like the pets they are
  // lit by the room's reflection map, get a soft blob shadow, and are steered here. Coordinates are Blender ones
  // (x, y on the floor, z up) and a heading of 0 faces the back wall, exactly as for the pets.
  const TOY_ENV = [2.6, 1.3]; // how strongly the room lights them at night and by day
  const toyMats = [];
  const toyRoot = toysGltf ? toysGltf.scene : null;
  const T = (name) => (toyRoot ? toyRoot.getObjectByName(name) : null);
  const clamp = THREE.MathUtils.clamp;
  if (toyRoot) {
    const swapped = new Map();
    toyRoot.traverse((o) => {
      if (!o.isMesh) return;
      const src = o.material, md = src.userData || {};
      if (md.fish) return; // the fish get their own shader further down
      if (!swapped.has(src)) {
        if (md.glow) {
          const c = src.emissive.clone();
          c.multiplyScalar(2.0 / Math.max(c.r, c.g, c.b, 1e-3));
          swapped.set(src, new THREE.MeshBasicMaterial({ color: c, toneMapped: false }));
        } else { // mirror-smooth parts (the vacuum's lid, the car's windows) take less of the room's light, or they turn into glowing mirrors
          src.userData.envK = src.roughness < 0.15 ? 0.32 : 1; src.envMapIntensity = TOY_ENV[0] * src.userData.envK; toyMats.push(src); swapped.set(src, src);
          if (src.name === 'RariPaint') { src.emissive.copy(src.color); src.emissiveIntensity = 0.22; } // the red stays red in the room's dim corners
        }
      }
      o.material = swapped.get(src);
    });
  }
  const makeBlob = (w, l, opacity) => {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity }));
    b.rotation.x = -Math.PI / 2; b.scale.set(w, l, 1); b.renderOrder = 1;
    room.add(b);
    return b;
  };
  const hot = (root, key) => root.traverse((m) => { if (m.isMesh) { m.userData.key = key; hotMeshes.push(m); } });
  const nearestNode = (x, y) => Object.keys(FLOOR).reduce((b, n) => (Math.hypot(FLOOR[n][0] - x, FLOOR[n][1] - y) < Math.hypot(FLOOR[b][0] - x, FLOOR[b][1] - y) ? n : b));
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();

  // --- the robot vacuum: charges in its dock, backs out, wanders the same floor points as the pets (turning on the
  // spot like the real thing, now and then spinning to scrub one patch), then drives home. The cat likes a ride.
  const vacRoot = T('Vac');
  const LED_CLEAN = new THREE.Color(0x27e0ff).multiplyScalar(2), LED_CHARGE = new THREE.Color(0x4dff9a).multiplyScalar(1.6), LED_WAIT = new THREE.Color(0xffb020).multiplyScalar(2);
  if (vacRoot) {
    vac = { root: vacRoot, x: DOCK[0], y: DOCK[1], heading: 0, state: 'docked', t: 0, wait: 36 + Math.random() * 12, path: [], node: 'c', rider: null, boarding: null, spin: 0, moved: 0, go: false,
      brush: T('Vac_Brush'), led: T('Vac_Led'), blob: makeBlob(0.5, 0.5, 0.75) };
    if (vac.led) vac.led.material = vac.led.material.clone();
    vacRoot.position.set(DOCK[0], 0, -DOCK[1]); vac.blob.position.set(DOCK[0], 0.006, -DOCK[1]);
    if (!reduceMotion) hot(vacRoot, 'vac');
  }
  function vacDrive(to, dt, speed, reverse) { // turn toward the point, then roll to it; true once it is there
    const v = vac, dx = to[0] - v.x, dy = to[1] - v.y, dist = Math.hypot(dx, dy);
    if (dist < 0.012) return true;
    const d = angDiff(Math.atan2(dx, -dy) + (reverse ? Math.PI : 0), v.heading);
    if (Math.abs(d) > 0.02) v.heading += Math.sign(d) * Math.min(Math.abs(d), 1.8 * dt);
    if (Math.abs(d) > 0.2) return false;
    const st = Math.min(dist, speed * dt);
    v.x += (dx / dist) * st; v.y += (dy / dist) * st; v.moved = st;
    return false;
  }
  function vacHome() { const v = vac; v.path = [...route(v.node, 'c').map((n) => FLOOR[n]), DOCK_OUT]; v.node = 'c'; v.spin = 0; v.state = 'home'; }
  function tickVac(dt, t) {
    const v = vac;
    v.moved = 0; v.t += dt;
    let led = LED_CLEAN, level = 1;
    const fx = Math.sin(v.heading), fy = -Math.cos(v.heading);
    const blocked = pets.some((p) => p !== v.rider && p.z < 0.06 && Math.hypot(p.x - v.x, p.y - v.y) < 0.46 && (p.x - v.x) * fx + (p.y - v.y) * fy > 0.12);
    if (v.state === 'docked') {
      led = LED_CHARGE; level = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 2.2));
      v.heading += angDiff(0, v.heading) * Math.min(1, dt * 4);
      const carOut = rari && rari.state !== 'parked';
      if (!v.boarding && (v.go || (v.t > v.wait && !carOut))) { v.go = false; v.state = 'undock'; sound.beep(); }
    } else if (v.state === 'undock') {
      if (vacDrive(DOCK_OUT, dt, 0.16, true)) { // out of the dock: pick a round of floor points
        v.path = [FLOOR.c];
        let n = 'c', prev = null;
        for (let i = v.rider ? 4 : 6 + Math.floor(Math.random() * 4); i > 0; i--) {
          const opts = adj[n].filter((m) => m !== prev);
          prev = n; n = opts[Math.floor(Math.random() * opts.length)] || prev;
          v.path.push(FLOOR[n]);
        }
        v.node = n; v.state = 'clean';
      }
    } else if (v.state === 'clean') {
      if (v.spin > 0) { const a = Math.min(v.spin, 2.4 * dt); v.heading += a; v.spin -= a; v.moved = 0.001; }
      else if (blocked) { led = LED_WAIT; level = 0.6 + 0.4 * Math.sin(t * 9); }
      else if (vacDrive(v.path[0], dt, 0.25, false)) {
        v.path.shift();
        if (!v.path.length) { if (v.rider) { v.state = 'unload'; v.t = 0; } else vacHome(); }
        else if (Math.random() < 0.3) v.spin = Math.PI * 2;
      }
    } else if (v.state === 'unload') { // stopped so the cat can hop off
      led = LED_WAIT;
      if (!v.rider && v.t > 2.2) vacHome();
      if (v.rider) v.t = 0;
    } else if (v.state === 'home') {
      if (blocked) { led = LED_WAIT; level = 0.6 + 0.4 * Math.sin(t * 9); }
      else if (vacDrive(v.path[0], dt, 0.25, false)) { v.path.shift(); if (!v.path.length) v.state = 'dockin'; }
    } else if (v.state === 'dockin') {
      if (vacDrive(DOCK, dt, 0.13, false)) { v.state = 'docked'; v.t = 0; v.wait = 30 + Math.random() * 25; sound.beep(); }
    }
    v.root.position.set(v.x, 0, -v.y);
    v.root.rotation.y = v.heading;
    if (v.brush && v.moved) v.brush.rotation.y += dt * 17;
    if (v.led) v.led.material.color.copy(led).multiplyScalar(level * glowDim);
    v.blob.position.set(v.x, 0.006, -v.y);
  }
  function vacClick() {
    const v = vac;
    if (v.state === 'docked') { if (!v.boarding) v.go = true; }
    else if (v.state === 'clean' && !v.rider) { sound.beep(); vacHome(); }
  }

  // --- the toy car: parked nose-out between the boxes and the plant. Every so often (or on a click) it pulls out, runs
  // a few laps of the open floor, turns in and reverses back into its spot. The dog gives chase; the cat gets out of the way.
  const LAP = [[1.55, 2.3], [2.6, 2.08], [3.7, 2.3], [4.2, 3.0], [3.8, 3.72], [2.75, 3.95], [1.65, 3.72], [1.15, 3.05]];
  const LAP_MID = [2.7, 3.0];
  const rariRoot = T('Rari');
  if (rariRoot) {
    const shell = new THREE.Group(); // body, lights and aerial lean together in the corners; the wheels stay flat
    ['Rari_Body', 'Rari_Lights', 'Rari_Tail', 'Rari_Antenna'].forEach((n) => { const o = T(n); if (o) shell.add(o); });
    rariRoot.add(shell);
    const wheels = ['FL', 'FR', 'RL', 'RR'].map((k) => {
      const w = T('Rari_Wheel' + k), piv = new THREE.Group();
      piv.position.copy(w.position);
      rariRoot.add(piv); piv.add(w); w.position.set(0, 0, 0);
      return { w, piv, front: k[0] === 'F', r: piv.position.y };
    });
    const lights = T('Rari_Lights');
    if (lights) lights.material = lights.material.clone();
    const beam = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.85), new THREE.MeshBasicMaterial({ map: halo.material.map, color: 0xcfe2ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    beam.rotation.x = -Math.PI / 2; beam.position.set(0, 0.009, 0.6); beam.layers.set(1);
    rariRoot.add(beam);
    rari = { root: rariRoot, shell, wheels, lights, beam, antenna: T('Rari_Antenna'), headBase: lights ? lights.material.color.clone() : null, x: PARK[0], y: PARK[1], heading: 0, state: 'parked', t: 0, wait: 16 + Math.random() * 8,
      v: 0, s: 0, len: 1, curve: null, steer: 0, blocked: 0, go: false, blob: makeBlob(0.34, 0.62, 0.8) };
    rariRoot.position.set(PARK[0], 0, -PARK[1]); rari.blob.position.set(PARK[0], 0.006, -PARK[1]);
    if (!reduceMotion) hot(rariRoot, 'rari');
  }
  const toV3 = ([x, y]) => new THREE.Vector3(x, 0, -y);
  function freePet(pet) { // drop whatever the pet had planned, and whatever it had reserved
    Object.values(PERCH).forEach((s) => { if (s.busy === pet) s.busy = null; });
    if (vac && vac.boarding === pet) vac.boarding = null;
    pet.queue.length = 0;
  }
  function scareCat(cat) { // the car is coming: straight to the nearest free high place
    if (cat.z > 0.01 || !cat.act || cat.act.type === 'jump' || cat.act.type === 'ride') return;
    freePet(cat);
    const here = nearestNode(cat.x, cat.y), free = Object.values(PERCH).filter((s) => !s.busy && s.who !== 'dog');
    cat.act = { type: 'walk', to: FLOOR[here] }; cat.node = here;
    if (!free.length) return;
    cat.rush = 1.9;
    queuePerch(cat, free.reduce((b, q) => (route(here, q.from).length < route(here, b.from).length ? q : b)), 16 + Math.random() * 8);
  }
  function startRun() {
    const r = rari, laps = 2 + Math.floor(Math.random() * 2), pts = [PARK, [2.37, 4.02], [2.24, 3.8], LAP[6], LAP[7]];
    for (let k = 0; k < laps; k++) for (let i = 0; i < LAP.length; i++) { if (k === laps - 1 && i > 4) break; pts.push(LAP[i]); }
    pts.push([3.05, 3.93], [2.6, 3.9], [2.42, 3.74], PARK_OUT);
    r.curve = new THREE.CatmullRomCurve3(pts.map(toV3), false, 'centripetal');
    r.curve.arcLengthDivisions = pts.length * 40;
    Object.assign(r, { len: r.curve.getLength(), state: 'run', s: 0, v: 0, blocked: 0, go: false });
    sound.rev();
    pets.forEach((p) => { if (p.kind === 'cat') scareCat(p); });
  }
  function tickRari(dt, t) {
    const r = rari;
    let dist = 0, steer = 0;
    if (r.state === 'parked') {
      r.t += dt;
      const vacBusy = vac && (vac.state !== 'docked' || vac.boarding);
      if (r.go || (r.t > r.wait && !vacBusy)) startRun();
    } else if (r.state === 'run') {
      const u = Math.min(1, r.s / r.len), tg = r.curve.getTangentAt(u, tmpA), ta = r.curve.getTangentAt(Math.min(1, (r.s + 0.3) / r.len), tmpB);
      let target = clamp(1.75 - 1.9 * Math.acos(clamp(tg.dot(ta), -1, 1)), 0.6, 1.75); // fast on the straights, slower through the bends
      const left = r.len - r.s;
      if (left < 0.9) target = Math.min(target, 0.25 + left * 1.2);
      // brake for anything on the floor right ahead; after a second of waiting, honk it out of the way
      const fx = tg.x, fy = -tg.z;
      const ahead = (ox, oy, reach) => { const dx = ox - r.x, dy = oy - r.y, d = Math.hypot(dx, dy); return d < reach && (dx * fx + dy * fy) / (d || 1) > 0.72; };
      const blocker = pets.find((p) => p.z < 0.06 && ahead(p.x, p.y, p.act && p.act.type === 'chase' ? 0.42 : 0.75));
      if (blocker || (vac && vac.state !== 'docked' && ahead(vac.x, vac.y, 0.8))) {
        target = 0; r.blocked += dt;
        if (r.blocked > 1.1) { r.blocked = -1.6; sound.honk(); if (blocker && blocker.act && blocker.act.type === 'wait') blocker.act.t = blocker.act.dur; }
      } else r.blocked = 0;
      r.v += clamp(target - r.v, -3.4 * dt, 1.5 * dt);
      dist = r.v * dt; r.s = Math.min(r.len, r.s + dist);
      const p = r.curve.getPointAt(Math.min(1, r.s / r.len), tmpC);
      r.x = p.x; r.y = -p.z; r.heading = Math.atan2(tg.x, tg.z);
      steer = clamp(angDiff(Math.atan2(ta.x, ta.z), r.heading) * 0.9, -0.5, 0.5);
      if (r.s >= r.len) { r.state = 'reverse'; r.v = 0; }
    } else { // reversing into its spot
      r.heading += angDiff(0, r.heading) * Math.min(1, dt * 6);
      const gap = PARK[1] - r.y;
      r.v = -Math.min(0.55, 0.12 + gap * 1.3);
      dist = r.v * dt;
      r.y = Math.min(PARK[1], r.y - dist); r.x += (PARK[0] - r.x) * Math.min(1, dt * 4);
      if (gap < 0.004) { r.state = 'parked'; r.t = 0; r.wait = 50 + Math.random() * 40; r.v = 0; dist = 0; }
    }
    r.steer += (steer - r.steer) * Math.min(1, dt * 10);
    r.root.position.set(r.x, 0, -r.y);
    r.root.rotation.y = r.heading;
    r.wheels.forEach((w) => { w.w.rotation.x += dist / w.r; if (w.front) w.piv.rotation.y = r.steer; });
    r.shell.rotation.z = -r.steer * r.v * 0.045;
    r.shell.rotation.x = 0.004 * Math.sin(t * 31) * Math.min(1, Math.abs(r.v));
    if (r.antenna) r.antenna.rotation.z = r.steer * r.v * 0.25 + 0.03 * Math.sin(t * 17) * Math.min(1, Math.abs(r.v));
    const on = r.state === 'parked' ? 0.3 : 1;
    if (r.lights) r.lights.material.color.copy(r.headBase).multiplyScalar(on * glowDim);
    r.beam.material.opacity = (r.state === 'parked' ? 0 : 0.34) * (1 - 0.75 * day);
    r.blob.position.set(r.x, 0.006, -r.y); r.blob.rotation.z = r.heading;
  }
  function rariClick() { if (rari.state === 'parked') rari.go = true; else sound.honk(); }
  // the dog drops what it is doing and runs after the car whenever the car is out and the dog is on the floor
  function dogChase() {
    const dog = pets.find((p) => p.kind === 'dog');
    if (!dog || !rari || rari.state !== 'run' || dog.z > 0.01 || !dog.act || dog.act.type === 'jump' || dog.act.type === 'chase') return;
    freePet(dog);
    dog.act = { type: 'chase' };
  }

  // --- the aquarium: the tank and everything planted in it are baked into the room; the water, the shoal, the bubbles
  // and the shafts of light are made here, inside the box the "Aq_Water" marker gives. Clicking the tank feeds the fish.
  if (waterMesh && toyRoot) {
    const box = new THREE.Box3().setFromObject(waterMesh), size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
    const long = size.x > size.z ? 'x' : 'z', deep = long === 'x' ? 'z' : 'x', top = box.max.y, floorY = box.min.y + 0.085;
    waterMesh.material = new THREE.MeshBasicMaterial({ color: 0x2aa9d6, transparent: true, opacity: 0.115, depthWrite: false });
    if (!reduceMotion) { waterMesh.userData.key = 'tank'; hotMeshes.push(waterMesh); }
    const group = new THREE.Group();
    room.add(group);
    // shafts of light slanting down through the water
    const [sc, sx] = makeCanvas(32, 128);
    const sg = sx.createLinearGradient(0, 0, 0, 128);
    sg.addColorStop(0, 'rgba(255,255,255,0.9)'); sg.addColorStop(1, 'rgba(255,255,255,0)');
    sx.fillStyle = sg; sx.fillRect(0, 0, 32, 128);
    const sh = sx.getImageData(0, 0, 32, 128);
    for (let i = 0; i < 32; i++) for (let j = 0; j < 128; j++) sh.data[(j * 32 + i) * 4 + 3] *= Math.sin((Math.PI * (i + 0.5)) / 32) ** 2; // soft edges
    sx.putImageData(sh, 0, 0);
    const shaftTex = new THREE.CanvasTexture(sc);
    const shafts = Array.from({ length: 5 }, (_, i) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shaftTex, color: 0xcfefff, transparent: true, opacity: 0.1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      m.scale.set(0.09 + 0.05 * (i % 3), size.y, 1);
      m.position.copy(mid); m.position[long] += (i / 4 - 0.5) * size[long] * 0.8; m.position[deep] += ((i * 37) % 5 - 2) * 0.03;
      if (long === 'z') m.rotation.y = Math.PI / 2;
      m.userData = { at: m.position[long], seed: i * 2.1 };
      m.layers.set(1);
      group.add(m);
      return m;
    });
    // the surface: a faint shimmer seen from above and below
    const surface = new THREE.Mesh(new THREE.PlaneGeometry(size.x, size.z), new THREE.MeshBasicMaterial({ color: 0xbfe9ff, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    surface.rotation.x = -Math.PI / 2; surface.position.set(mid.x, top - 0.001, mid.z); surface.layers.set(1);
    group.add(surface);
    // bubbles from the air stone, and the flakes that fall when the fish are fed
    const NB = 22, bubPos = new Float32Array(NB * 3), bubSeed = Array.from({ length: NB }, () => [Math.random(), 0.6 + Math.random() * 0.8, Math.random() * 6.28]);
    const bubGeo = new THREE.BufferGeometry();
    bubGeo.setAttribute('position', new THREE.BufferAttribute(bubPos, 3));
    const bubbles = new THREE.Points(bubGeo, new THREE.PointsMaterial({ map: dotTex, size: 0.016, transparent: true, opacity: 0.75, depthWrite: false, color: 0xe6f8ff }));
    bubbles.frustumCulled = false; bubbles.layers.set(1);
    const NF = 16, flakePos = new Float32Array(NF * 3).fill(-99), flakeSeed = Array.from({ length: NF }, () => [Math.random() - 0.5, Math.random() - 0.5, 0.5 + Math.random() * 0.8, Math.random() * 6.28]);
    const flakeGeo = new THREE.BufferGeometry();
    flakeGeo.setAttribute('position', new THREE.BufferAttribute(flakePos, 3));
    const flakes = new THREE.Points(flakeGeo, new THREE.PointsMaterial({ size: 0.006, color: 0xe8a23c, transparent: true, opacity: 0.95, depthWrite: false }));
    flakes.frustumCulled = false; flakes.layers.set(1); flakes.visible = false;
    group.add(bubbles, flakes);
    // the fish: each species is one small painted mesh; a shader bends it from side to side toward the tail
    const fishMaterial = (len) => new THREE.ShaderMaterial({
      vertexColors: true, side: THREE.DoubleSide,
      uniforms: { uPhase: { value: 0 }, uAmp: { value: 1 }, uLen: { value: len }, uLevel: { value: 1.25 } },
      vertexShader: `uniform float uPhase; uniform float uAmp; uniform float uLen; varying vec3 vCol; varying vec3 vN;
        void main() {
          vec3 p = position;
          float tail = clamp( 0.36 - p.z / uLen, 0.0, 1.15 ); // the nose is at +z; the further back, the wider the swing
          p.x += uAmp * uLen * 0.15 * sin( uPhase + p.z / uLen * 5.0 ) * tail * tail;
          vCol = color.rgb;
          vN = normalize( normalMatrix * normal );
          gl_Position = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
        }`,
      fragmentShader: `uniform float uLevel; varying vec3 vCol; varying vec3 vN;
        void main() {
          vec3 n = normalize( vN ); if ( !gl_FrontFacing ) n = -n;
          vec3 up = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
          float lit = 0.5 + 0.6 * max( dot( n, up ), 0.0 ) + 0.3 * pow( max( n.z, 0.0 ), 3.0 ); // the tank light from above, plus a sheen toward the viewer
          gl_FragColor = vec4( vCol * lit * uLevel, 1.0 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const lo = new THREE.Vector3(box.min.x + 0.04, floorY, box.min.z + 0.04), hi = new THREE.Vector3(box.max.x - 0.04, top - 0.045, box.max.z - 0.04);
    const spot = (y0, y1, out = new THREE.Vector3()) => out.set(lo.x + Math.random() * (hi.x - lo.x), lo.y + (y0 + Math.random() * (y1 - y0)) * (hi.y - lo.y), lo.z + Math.random() * (hi.z - lo.z));
    const fishes = [];
    const few = small || quality === 'low' || quality === 'min';
    [['Fish_Tetra', few ? 5 : 9, 0.052, 0.085, [0.25, 0.75]], ['Fish_Gold', 3, 0.1, 0.05, [0.05, 0.6]], ['Fish_Angel', 2, 0.09, 0.04, [0.3, 0.9]]].forEach(([name, n, len, speed, band]) => {
      const src = T(name);
      if (!src) return;
      src.visible = false;
      for (let i = 0; i < n; i++) {
        const mat = fishMaterial(len), mesh = new THREE.Mesh(src.geometry, mat);
        mesh.rotation.order = 'YXZ'; mesh.frustumCulled = false; mesh.layers.set(1);
        mesh.scale.setScalar(0.88 + Math.random() * 0.26);
        const f = { mesh, mat, kind: name, band, speed: speed * (0.85 + Math.random() * 0.3), p: spot(band[0], band[1]), v: new THREE.Vector3((Math.random() - 0.5) * 0.05, 0, (Math.random() - 0.5) * 0.02), to: spot(band[0], band[1]), timer: Math.random() * 4,
          off: new THREE.Vector3((Math.random() - 0.5) * 0.14, (Math.random() - 0.5) * 0.07, (Math.random() - 0.5) * 0.1), phase: Math.random() * 6 };
        mesh.position.copy(f.p); mesh.rotation.y = Math.atan2(f.v.x, f.v.z);
        group.add(mesh);
        fishes.push(f);
      }
    });
    const school = { to: spot(0.25, 0.75), timer: 0 }; // the tetras keep together: one shared goal, each fish a little off it
    const feedAt = new THREE.Vector3();
    tank = { fishes, feed: 0, fed: 0, box, plants: all(/^AqPlant\d+$/) };
    tank.plants.forEach((p) => { p.userData.q0 = p.quaternion.clone(); });
    const swayE = new THREE.Euler();
    tank.feedNow = () => {
      if (tank.feed > 0) return;
      tank.feed = 8; tank.fed++;
      feedAt.set(mid.x, top, mid.z); feedAt[long] += (Math.random() - 0.5) * size[long] * 0.5;
      flakes.visible = true;
      sound.plop();
    };
    tank.tick = (dt, t) => {
      shafts.forEach((m) => { m.position[long] = m.userData.at + 0.03 * Math.sin(t * 0.4 + m.userData.seed); m.material.opacity = (0.05 + 0.06 * (0.5 + 0.5 * Math.sin(t * 0.9 + m.userData.seed * 1.7))) * glowDim; });
      surface.material.opacity = 0.12 + 0.05 * Math.sin(t * 1.3);
      for (let i = 0; i < NB; i++) {
        const [ph, sp, w] = bubSeed[i], u = (ph + t * sp * 0.32) % 1;
        bubPos[i * 3] = airStone.x + 0.012 * Math.sin(t * 5 + w) * (0.3 + u);
        bubPos[i * 3 + 1] = airStone.y + u * (top - airStone.y);
        bubPos[i * 3 + 2] = airStone.z + 0.012 * Math.cos(t * 4.3 + w) * (0.3 + u);
      }
      bubGeo.attributes.position.needsUpdate = true;
      const feeding = tank.feed > 0;
      if (feeding) {
        tank.feed -= dt;
        const age = 8 - tank.feed;
        for (let i = 0; i < NF; i++) {
          const [ox, oz, sp, w] = flakeSeed[i], sink = Math.min(top - floorY + 0.02, age * 0.035 * sp);
          flakePos[i * 3] = feedAt.x + (long === 'x' ? ox * 0.22 : oz * 0.1) + 0.01 * Math.sin(t * 1.7 + w);
          flakePos[i * 3 + 1] = top - 0.004 - sink;
          flakePos[i * 3 + 2] = feedAt.z + (long === 'x' ? oz * 0.1 : ox * 0.22) + 0.01 * Math.cos(t * 1.3 + w);
        }
        flakeGeo.attributes.position.needsUpdate = true;
        flakes.material.opacity = Math.min(0.95, tank.feed * 0.6);
        if (tank.feed <= 0) flakes.visible = false;
      }
      if ((school.timer -= dt) < 0) { spot(0.25, 0.75, school.to); school.timer = 4 + Math.random() * 5; }
      for (const f of fishes) {
        if ((f.timer -= dt) < 0 || f.p.distanceToSquared(f.to) < 0.0016) { spot(f.band[0], f.band[1], f.to); f.timer = 3 + Math.random() * 6; }
        const goal = tmpA.copy(f.kind === 'Fish_Tetra' ? school.to : f.to);
        if (f.kind === 'Fish_Tetra') goal.add(f.off);
        let sp = f.speed;
        if (feeding) { goal.copy(feedAt).add(f.off); goal.y = top - 0.03 - Math.min(0.2, (8 - tank.feed) * 0.03) + f.off.y * 0.5; sp *= 2.2; }
        goal.clamp(lo, hi);
        const want = tmpB.copy(goal).sub(f.p), d = want.length();
        want.multiplyScalar((sp * Math.min(1, d / 0.05)) / (d || 1));
        f.v.lerp(want, 1 - Math.exp(-dt * 1.8));
        f.p.addScaledVector(f.v, dt).clamp(lo, hi);
        const v = f.v.length();
        f.mesh.position.copy(f.p);
        if (v > 0.004) {
          const yaw = Math.atan2(f.v.x, f.v.z);
          f.mesh.rotation.y += angDiff(yaw, f.mesh.rotation.y) * Math.min(1, dt * 5);
          f.mesh.rotation.x = clamp(-Math.asin(clamp(f.v.y / v, -1, 1)) * 0.7, -0.6, 0.6);
        }
        f.phase += dt * (3.5 + v * 70);
        f.mat.uniforms.uPhase.value = f.phase;
        f.mat.uniforms.uAmp.value = 0.55 + Math.min(1, v * 9);
      }
      tank.plants.forEach((p, i) => { p.quaternion.copy(p.userData.q0).multiply(qTmp.setFromEuler(swayE.set(0.05 * Math.sin(t * 0.9 + i * 1.3), 0, 0.035 * Math.sin(t * 0.7 + i * 2.1)))); }); // the plants lean with the current
    };
  }

  // floating sun / moon badge over the bed: shows what a click on the bed will switch to
  const [hintCv, hintCx] = makeCanvas(128, 128);
  const hintTex = new THREE.CanvasTexture(hintCv);
  hintTex.colorSpace = THREE.SRGBColorSpace;
  function drawBedHint(toDay) {
    const x = hintCx;
    x.clearRect(0, 0, 128, 128);
    x.fillStyle = 'rgba(13,11,26,0.82)'; x.beginPath(); x.arc(64, 64, 56, 0, 7); x.fill();
    x.strokeStyle = toDay ? '#ffd24a' : '#8fb4ff'; x.lineWidth = 5; x.stroke();
    x.fillStyle = toDay ? '#ffd24a' : '#cfe0ff'; x.font = '72px "Segoe UI Symbol", "Segoe UI", sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(toDay ? '☀' : '☾', 64, 68);
    hintTex.needsUpdate = true;
  }
  drawBedHint(true);
  const bedHint = new THREE.Sprite(new THREE.SpriteMaterial({ map: hintTex, transparent: true, depthWrite: false, toneMapped: false }));
  const BED_HINT_Y = 0.98;
  bedHint.position.copy(B(5.0, 4.0, BED_HINT_Y)); bedHint.scale.setScalar(0.2);
  room.add(bedHint);

  // ------------------------------------------------------------------ reflections: capture the lit room
  function captureEnv() {
    mirrors.forEach((m) => { m.visible = false; });
    const crt = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
    const cube = new THREE.CubeCamera(0.05, 700, crt);
    cube.position.copy(B(2.6, 2.3, 1.4));
    scene.add(cube);
    cube.update(renderer, scene);
    scene.remove(cube);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromCubemap(crt.texture).texture;
    pmrem.dispose(); crt.dispose();
    mirrors.forEach((m) => { m.visible = true; });
    return env;
  }
  const envNight = captureEnv();
  scene.environment = envNight;

  // ------------------------------------------------------------------ post-processing
  // Small props are drawn by the main camera only (layer 1), not by the two reflection passes: they are too
  // small to read in a reflection, and skipping them removes roughly a fifth of all draw calls.
  const NO_REFLECT = /^(Book\d|Penguin\d|KeyGlow_|LED_Pad\d|LED_ArcBtn\d|LED_Disp\d|LED_Rack\d|PC_|Mic_Ring|ShelfCam|Mouse$|PowerLED|Holo_Ring|LED_Marquee)/;
  room.traverse((o) => { if (NO_REFLECT.test(o.name)) o.traverse((c) => c.layers.set(1)); });
  [holo, dust, phoneFeed, bedHint, ...scanBars, ...videoFaces.filter(Boolean).map((f) => f.parent)].forEach((o) => o.traverse((c) => c.layers.set(1)));

  const rt = new THREE.WebGLRenderTarget(1, 1, { samples: small ? 2 : 4, type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.36, 0.55, 1.0);
  composer.addPass(bloom);
  const fx = new ShaderPass(FX_SHADER);
  composer.addPass(fx);
  composer.addPass(new OutputPass());

  // ------------------------------------------------------------------ day / night
  // `day` runs 0 (night) to 1 (day). The baked lighting cross-fades in the surface shader; everything else that
  // depends on the time of day (sky, sun or moon, city, ground, glow strength, reflections) follows it here.
  const SKY_N = { zenith: ZENITH.clone(), horizon: HORIZON.clone(), haze: HAZE.clone(), disc: moon.material.color.clone(), halo: halo.material.color.clone(), city: new THREE.Color(0x8d87ad) };
  // daytime is a late, golden afternoon: soft blue overhead, peach at the horizon, an amber sun
  const SKY_D = { zenith: new THREE.Color(0x5f86c4), horizon: new THREE.Color(0xe9b48c), haze: new THREE.Color(0x2c190c), disc: new THREE.Color(3.0, 2.2, 1.3), halo: new THREE.Color(0xffc98a), city: new THREE.Color(0xb39a94) };
  const GLASS_N = glassMat.color.clone(), GLASS_D = new THREE.Color(0xffe9d2);
  const staticGlow = [...glowShared.values()].map((m) => ({ m, base: m.color.clone() }));
  // Everything hanging on a wall that is not a baked surface (screens, glass, glowing strips, flat-colour shells)
  // gets its own copy of its material that fades with that wall. Baked surfaces were given theirs when classified.
  const glassMats = [glassMat], fadeCopies = new Map(), wallMeshes = { B: [], L: [], F: [], R: [] };
  sided.forEach((o) => {
    if (!o.parent || !o.material || o.material.userData.side) return;
    const m = o.material, k = m.uuid + o.userData.side;
    if (!fadeCopies.has(k)) {
      const c = addFade(m.clone(), o.userData.side);
      fadeCopies.set(k, c);
      const sg = staticGlow.find((g) => g.m === m);
      if (sg) staticGlow.push({ m: c, base: sg.base });
      if (m === glassMat) glassMats.push(c);
    }
    o.material = fadeCopies.get(k);
  });
  room.traverse((o) => { const sd = o.isMesh && o.material && o.material.userData.side; if (sd) wallMeshes[sd].push(o); });
  // a wall is solid while the camera is on its room side and gone once the camera is level with it or beyond
  const WALL_PLANE = { B: ['z', 0, 1], L: ['x', 0, -1], F: ['z', -RY, -1], R: ['x', RX, 1] }; // axis, position, outward direction
  const camLocal = new THREE.Vector3(), wallShown = { B: true, L: true, F: true, R: true };
  function updateWalls(dt) {
    room.worldToLocal(camera.getWorldPosition(camLocal));
    for (const sd in WALL_PLANE) {
      const [axis, at, out] = WALL_PLANE[sd], outside = (camLocal[axis] - at) * out;
      const target = 1 - THREE.MathUtils.smoothstep(outside, -0.35, 0.0), u = wallFade[sd]; // gone by the time the camera reaches the wall, so it is never looked through half-dissolved
      u.value += THREE.MathUtils.clamp(target - u.value, -dt * 4, dt * 4); // a steady quarter-second dissolve that always lands exactly on its target
      const show = u.value > 0.012;
      if (show !== wallShown[sd]) { wallShown[sd] = show; wallMeshes[sd].forEach((m) => { m.visible = show; }); }
    }
  }
  updateWalls(1);
  let day = 0, dayTo = 0, glowDim = 1, envDay = null, dayReady = null;
  function applyDay(d) {
    dayU.value = d;
    ZENITH.lerpColors(SKY_N.zenith, SKY_D.zenith, d); HORIZON.lerpColors(SKY_N.horizon, SKY_D.horizon, d); HAZE.lerpColors(SKY_N.haze, SKY_D.haze, d);
    groundColor.copy(HORIZON).add(HAZE.clone().multiplyScalar(0.55)); // the ground always meets the horizon colour
    groundMirror.material.uniforms.uBase.value.copy(groundColor);
    groundMirror.material.uniforms.uGlow.value = 0.09 * (1 - d);
    moon.material.color.lerpColors(SKY_N.disc, SKY_D.disc, d);
    halo.material.color.lerpColors(SKY_N.halo, SKY_D.halo, d); halo.material.opacity = 0.6 + 0.3 * d;
    starLayers[0].material.opacity = 0.85 * (1 - d);
    if (skyline) {
      const map = d > 0.5 ? null : skylineMap; // lit windows at night, plain silhouettes by day
      if (skyline.material.map !== map) { skyline.material.map = map; skyline.material.needsUpdate = true; }
      skyline.material.color.lerpColors(SKY_N.city, SKY_D.city, d);
    }
    bloom.strength = 0.36 - 0.12 * d;
    fx.uniforms.uAmount.value = 1 - 0.3 * d;
    renderer.toneMappingExposure = 1.3 - 0.2 * d;
    glowDim = 1 - 0.35 * d; // lights stay on by day but no longer dominate
    staticGlow.forEach((g) => g.m.color.copy(g.base).multiplyScalar(glowDim));
    if (neon) neon.material.color.copy(neon.userData.base).multiplyScalar(1 - 0.25 * d);
    // clear glass picks up the sky: by day that would paint the bar shelves blue, so it turns warmer and less mirror-like
    platesMeshes.forEach((m) => { m.material.emissiveIntensity = PLATE_LEVEL[0] + (PLATE_LEVEL[1] - PLATE_LEVEL[0]) * d; }); // printed plates read brighter in daylight
    glassMats.forEach((g) => { g.color.lerpColors(GLASS_N, GLASS_D, d); g.envMapIntensity = 1.6 - 1.0 * d; });
    petMatList.forEach((m) => { m.envMapIntensity = PET_ENV[0] + (PET_ENV[1] - PET_ENV[0]) * d; });
    toyMats.forEach((m) => { m.envMapIntensity = (TOY_ENV[0] + (TOY_ENV[1] - TOY_ENV[0]) * d) * m.userData.envK; });
    petKey.value.lerpVectors(PET_KEY_N, PET_KEY_D, d).normalize();
    if (namePlate) namePlate.material.color.setRGB(1 - 0.9 * d, 1 - 0.88 * d, 1 - 0.78 * d); // white lettering at night, dark navy on the pale daytime ground
    scene.environment = d > 0.5 && envDay ? envDay : envNight;
  }
  function loadDay() { // fetched in the background after the room is up, so it never delays the first view
    if (!dayReady) {
      dayReady = (async () => {
        if (!meta.day || !dayShaderOk) return false;
        const maps = await Promise.all(ATLASES.map((k) => texLoader.loadAsync(`assets/lm_${k}_day${sfx}.webp`)));
        maps.forEach((t, i) => { t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAniso; dayTex[ATLASES[i]].value = t; gain[ATLASES[i]].d.value = meta.day[ATLASES[i]].gain; });
        const keep = day;
        const fades = Object.values(wallFade).map((u) => u.value);
        Object.values(wallFade).forEach((u) => { u.value = 1; }); Object.values(wallMeshes).flat().forEach((m) => { m.visible = true; }); // all four walls in the reflection
        applyDay(1); envDay = captureEnv(); applyDay(keep); // daytime reflections, captured once
        Object.values(wallFade).forEach((u, i) => { u.value = fades[i]; }); for (const sd in wallShown) wallShown[sd] = true;
        return true;
      })().catch((err) => { console.warn('day lighting unavailable', err); return false; });
    }
    return dayReady;
  }
  async function toggleDay() {
    if (!(await loadDay())) return false;
    dayTo = dayTo ? 0 : 1;
    if (reduceMotion) { day = dayTo; applyDay(day); }
    drawBedHint(dayTo === 0);
    sound.open();
    api.onDay(dayTo === 1);
    return dayTo === 1;
  }
  setTimeout(loadDay, 3000);

  // ------------------------------------------------------------------ camera
  const controls = new OrbitControls(camera, canvas);
  const HOME_T = new THREE.Vector3(2.7, 0.9, -2.45), HOME_DIR = new THREE.Vector3(6.35, 4.1, -6.6);
  // The room can be orbited all the way round (no left/right stops): walls on the camera's side dissolve.
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, enablePan: false, minDistance: 3.5, maxDistance: 45, minPolarAngle: 0.65, maxPolarAngle: 1.52 });
  const ZOOM_OUT = 1.12; // furthest zoom-out, as a multiple of the default view's distance: the room never shrinks to a speck
  const homePos = () => HOME_T.clone().add(HOME_DIR.clone().multiplyScalar(THREE.MathUtils.clamp(1.2 / (innerWidth / innerHeight), 1, 4)));
  controls.maxDistance = homePos().distanceTo(HOME_T) * ZOOM_OUT;
  camera.position.copy(homePos()); controls.target.copy(HOME_T); controls.update();

  let tween = null, shift = 0, shiftTo = 0, floatAmt = 1;
  const wide = () => innerWidth > 720;
  function moveTo(pos, target, after, dur = 1.1) {
    if (reduceMotion) { camera.position.copy(pos); controls.target.copy(target); controls.update(); shift = shiftTo; after && after(); return; }
    tween = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target, t: 0, dur, after };
  }
  function focus(k) {
    const mesh = screens[k];
    if (!mesh) return;
    controls.enabled = false;
    floatAmt = 0; room.position.set(0, 0, 0); room.rotation.set(0, 0, 0);
    if (board) board.rotation.x = 0;
    room.updateMatrixWorld(true);
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const n = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.normal, 0).transformDirection(mesh.matrixWorld);
    const sw = Math.hypot(size.x, size.z), sh = size.y;
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const freeW = wide() ? innerWidth - panel.offsetWidth : innerWidth;
    const freeH = wide() ? innerHeight : innerHeight * 0.38;
    const fullH = (h) => (h * innerHeight) / freeH;
    const dist = Math.max(fullH(sh * 1.5) / (2 * tan), fullH(sw * 1.3) / (2 * tan * (freeW / freeH)));
    shiftTo = 1;
    n.y += 0.3; n.normalize();
    moveTo(center.clone().addScaledVector(n, dist), center);
  }
  function overview() {
    shiftTo = 0;
    moveTo(homePos(), HOME_T.clone(), () => { controls.enabled = true; });
  }

  // ------------------------------------------------------------------ pointer
  let hoverKey = null;
  function setHover(k) {
    if (k !== hoverKey) { hoverKey = k; if (k) sound.hover(); }
    for (const key in screens) screens[key].material.color.setScalar(baseLevel(key) * (key === k ? 1.35 : 1));
  }
  const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
  let downAt = null;
  const pick = (e) => {
    const r = canvas.getBoundingClientRect();
    ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, camera);
    const hit = ray.intersectObjects(hotMeshes.filter((m) => !m.userData.side || wallFade[m.userData.side].value > 0.5), false)[0];
    return hit ? hit.object.userData.key : null;
  };
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const k = pick(e);
    setHover(k === api.openKey ? null : k);
    canvas.style.cursor = k ? 'pointer' : 'grab';
    tip.hidden = !k || k === api.openKey;
    if (k) {
      const tips = { cat: 'Cat — click to say hi', dog: 'Dog — click to say hi', arcade: 'Arcade — click to play', bed: `Bed — click for ${dayTo ? 'night' : 'day'}`, tank: 'Aquarium — click to feed the fish',
        vac: vac && vac.state === 'docked' ? 'Robot vacuum — click to start it' : 'Robot vacuum — click to send it home', rari: rari && rari.state === 'parked' ? 'Toy car — click for a few laps' : 'Toy car — click to honk' };
      tip.textContent = tips[k] ?? content[k].title + ' — click to open';
      tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px';
    }
  });
  canvas.addEventListener('pointerleave', () => { tip.hidden = true; setHover(null); });
  canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; help.classList.add('hide'); });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
    const k = pick(e);
    tip.hidden = true;
    if (k === 'cat' || k === 'dog') { const pet = pets.find((p) => p.kind === k); if (pet) pet.react(); return; }
    if (k === 'arcade') { arcadeCoin(); return; }
    if (k === 'bed') { toggleDay(); return; }
    if (k === 'vac') { if (vac) vacClick(); return; }
    if (k === 'rari') { if (rari) rariClick(); return; }
    if (k === 'tank') { if (tank) tank.feedNow(); return; }
    if (k && k !== api.openKey) openPanel(k); else if (!k && api.openKey) closePanel();
  });

  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false); composer.setSize(w, h);
    mirrors.forEach((m) => m.getRenderTarget().setSize(...mirrorSize()));
    camera.aspect = w / h; camera.updateProjectionMatrix();
    controls.maxDistance = homePos().distanceTo(HOME_T) * ZOOM_OUT;
    if (!api.openKey && !tween) { camera.position.copy(homePos()); controls.target.copy(HOME_T); }
  }
  addEventListener('resize', resize); resize();

  if (!reduceMotion) { // opening shot: low and wide with the skyline behind, then crane up to the room
    controls.enabled = false;
    camera.position.copy(HOME_T).add(new THREE.Vector3(13.5, 0.3, -8.4));
    camera.lookAt(HOME_T.x, 1.7, HOME_T.z);
    tween = { p0: camera.position.clone(), t0: new THREE.Vector3(HOME_T.x, 1.7, HOME_T.z), p1: homePos(), t1: HOME_T.clone(), t: -0.2, dur: 3.4, after: () => { controls.enabled = true; } };
  }

  // ------------------------------------------------------------------ screens redraw only when their content changes
  let aboutKey = '', projKey = -1, screenClock = 0;
  const SLIDE_EVERY = 5;
  const projItems = content.projects.items.slice(0, 4);
  const slides = [(c, x) => art.drawProjects(c, x), ...projItems.map((it, i) => (c, x) => art.drawFeature(c, x, it, i, projItems.length))].map((draw) => {
    const [c, x] = makeCanvas(...SCREEN_SIZE.projects);
    draw(c, x);
    return c;
  });
  function tickScreens(t) {
    const len = content.tagline.length, typed = Math.max(0, Math.floor((t - 3.2) * 16));
    const key = typed < len ? 't' + typed : 'c' + (Math.floor(t * 2) % 2);
    if (key !== aboutKey && live.about) {
      aboutKey = key;
      art.drawAbout(live.about.cv, live.about.ctx, typed, typed < len || key === 'c0');
      live.about.tex.needsUpdate = true;
    }
    if (live.projects) {
      const n = slides.length, idx = Math.floor(t / SLIDE_EVERY) % n, local = t % SLIDE_EVERY;
      const p = local < 0.6 ? Math.round((local / 0.6) * 8) / 8 : 1, pk = idx * 10 + p;
      if (pk !== projKey) {
        projKey = pk;
        const e = p * p * (3 - 2 * p), W = live.projects.cv.width, x = live.projects.ctx;
        x.drawImage(slides[(idx + n - 1) % n], -e * W, 0);
        x.drawImage(slides[idx], (1 - e) * W, 0);
        live.projects.tex.needsUpdate = true;
      }
    }
  }

  // ------------------------------------------------------------------ frame-rate watchdog (only ever steps down)
  // tier 1 (< 40 fps): ground stops reflecting, lower resolution. tier 2 (< 25): no bloom, floor reflection or video.
  // tier 3 (< 18): no post-processing at all, 0.75x resolution.
  let perfFrames = -40, perfTime = 0, cpuAcc = 0, lastCalls = 0, tier = 0, direct = false, lowStreak = 0;
  function setTier(n) {
    tier = n;
    if (n >= 1) { pixelRatio = Math.min(pixelRatio, 1); renderer.setPixelRatio(pixelRatio); groundLive = false; groundMirror.material.uniforms.uStrength.value = 0; }
    if (n >= 2) { bloom.enabled = false; fx.enabled = false; floorMirror.visible = false; videos.forEach((v) => v.pause()); }
    if (n >= 3) { pixelRatio = 0.75; renderer.setPixelRatio(0.75); direct = true; }
    resize();
  }
  if (quality === 'low') setTier(1);
  if (quality === 'min') setTier(3);
  if (small && !pinned) setTier(1); // phones start one step down: no ground reflection pass, floor reflection stays

  // ?fps=1 shows a live frame-rate readout, handy for checking the site on a phone
  let fpsBox = null;
  if (new URLSearchParams(location.search).has('fps')) {
    fpsBox = document.createElement('div');
    fpsBox.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:30;padding:6px 10px;border-radius:8px;background:rgba(0,0,0,.7);color:#27e0ff;font:600 13px monospace;pointer-events:none';
    fpsBox.textContent = 'measuring…';
    document.body.appendChild(fpsBox);
  }

  // ------------------------------------------------------------------ loop
  const clock = new THREE.Clock(), col = new THREE.Color(), hslTmp = {};
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  function frame() {
    const cpu0 = performance.now();
    frameNo++;
    const raw = clock.getDelta(), dt = Math.min(raw, 0.05), t = clock.elapsedTime;
    if (document.visibilityState === 'visible' && raw < 0.25) {
      if (++perfFrames > 0) perfTime += raw;
      if (perfFrames === 60) {
        const fps = 60 / perfTime;
        window.__roomPerf = { fps: Math.round(fps), tier, pixelRatio, cpuMsPerFrame: +(cpuAcc / 60).toFixed(2), drawCalls: lastCalls, triangles: renderer.info.render.triangles };
        cpuAcc = 0;
        if (fpsBox) fpsBox.textContent = `${Math.round(fps)} fps · level ${tier} · ${canvas.width}×${canvas.height} · ${sfx ? '2K' : '4K'} textures`;
        // step down only after two slow readings in a row, so one browser hiccup can't cost quality
        const slow = (fps < 18 && tier === 2) || (fps < 25 && tier === 1) || (fps < 40 && tier === 0);
        lowStreak = slow ? lowStreak + 1 : 0;
        if (!pinned && lowStreak >= 2) { lowStreak = 0; setTier(tier + 1); }
        perfFrames = -15; perfTime = 0;
      }
    }
    if (tween) {
      tween.t = Math.min(1, tween.t + dt / tween.dur);
      const k = ease(Math.max(0, tween.t));
      camera.position.lerpVectors(tween.p0, tween.p1, k);
      controls.target.lerpVectors(tween.t0, tween.t1, k);
      camera.lookAt(controls.target);
      if (tween.t === 1) { const a = tween.after; tween = null; a && a(); }
    } else if (controls.enabled) controls.update();
    shift += (shiftTo - shift) * Math.min(1, dt * 5);
    if (shift > 0.002) {
      if (wide()) camera.setViewOffset(innerWidth, innerHeight, (panel.offsetWidth / 2) * shift, 0, innerWidth, innerHeight);
      else camera.setViewOffset(innerWidth, innerHeight, 0, innerHeight * 0.26 * shift, innerWidth, innerHeight);
    } else if (camera.view) camera.clearViewOffset();

    updateWalls(dt);
    if (day !== dayTo) { // glide between night and day over about two seconds
      day += (dayTo - day) * Math.min(1, dt * 2.2);
      if (Math.abs(dayTo - day) < 0.003) day = dayTo;
      applyDay(day);
    }
    if (!reduceMotion) {
      const open = api.openKey;
      // the whole room hovers over the mirror ground
      floatAmt += ((open ? 0 : 1) - floatAmt) * Math.min(1, dt * 2);
      room.position.y = floatAmt * (0.06 + 0.04 * Math.sin(t * 0.7));
      room.rotation.z = floatAmt * 0.005 * Math.sin(t * 0.5);
      room.rotation.x = floatAmt * 0.004 * Math.sin(t * 0.43 + 1);
      // lights: LEDs breathe, keyboard cycles. The neon name is deliberately left alone: steady, solid colour.
      leds.forEach((o, i) => { o.material.color.copy(o.userData.base).multiplyScalar((0.84 + 0.16 * Math.sin(t * 1.5 + i * 0.9)) * glowDim); });
      // (the keyboard keeps its static three-zone colours: no cycling)
      const flick = 0.93 + 0.05 * Math.sin(t * 9) * Math.sin(t * 2.3) + 0.02 * Math.sin(t * 23);
      if (shade) { shade.material.color.copy(shade.userData.base).multiplyScalar(flick * (1 - 0.45 * day)); shade.rotation.z = shade.userData.r.z + 0.02 * Math.sin(t * 0.8); }
      penguins.forEach((p, i) => { const w = Math.sin(t * 3 + i * 2.1); p.rotation.z = 0.13 * w; p.position.y = p.userData.p.y + 0.006 * Math.abs(w); });
      bedHint.position.y = BED_HINT_Y + 0.03 * Math.sin(t * 2);
      if (vac) tickVac(dt, t);
      if (rari) { tickRari(dt, t); dogChase(); }
      pets.forEach((pet) => tickPet(pet, dt, t));
      if (tank) tank.tick(dt, t);
      if (towerPom) { towerPom.rotation.x = 0.16 * Math.sin(t * 4.3); towerPom.rotation.z = 0.16 * Math.cos(t * 3.7); }
      if (towerBall) towerBall.rotation.x = 0.3 * Math.sin(t * 2.1);
      if (tradeMesh && (tube.clock += dt) > (tier >= 2 ? 0.3 : small ? 0.12 : 0.085)) { tube.clock = 0; drawTube(t); }
      if (chartMesh && (chartClock += dt) > 0.07) { chartClock = 0; tickChart(t); }
      // props
      fans.forEach((f, i) => { f.rotation.z += dt * (i % 2 ? -10 : 13); });
      if (chair) chair.rotation.y = chair.userData.r.y + 0.14 * Math.sin(t * 0.45);
      if (car) car.rotation.y += dt * 0.5;
      if (gem) { gem.rotation.y += dt * 1.2; gem.position.y = gem.userData.p.y + 0.012 * Math.sin(t * 2); }
      if (trophy) trophy.position.y = trophy.userData.p.y + 0.005 * (1 + Math.sin(t * 1.7));
      if (shelfCam) shelfCam.rotation.y = 0.5 * Math.sin(t * 0.5);
      if (mouse) { mouse.position.x = mouse.userData.p.x + 0.03 * Math.sin(t * 1.1); mouse.position.z = mouse.userData.p.z + 0.015 * Math.sin(t * 2.2); }
      plants.forEach((p, i) => { p.rotation.z = p.userData.r.z + 0.022 * Math.sin(t * 0.9 + i * 1.4); p.rotation.x = p.userData.r.x + 0.016 * Math.sin(t * 0.7 + i); });
      if (curtain) curtain.rotation.x = curtain.userData.r.x + 0.012 * Math.sin(t * 0.6);
      books.forEach((b, i) => { b.position.y = b.userData.p.y + 0.03 * Math.pow(Math.max(0, Math.sin(t * 1.4 - i * 0.7)), 6); });
      ship.forEach((s) => {
        const i = +s.name.slice(-1), u = (t + (i < 2 ? 0 : 2.7)) % 6.5;
        s.position.y = s.userData.p.y + (u < 0.45 ? Math.sin((Math.PI * u) / 0.45) : 0) * [0.02, 0.05, 0.045][i];
      });
      lids.forEach((l, i) => { l.position.y = l.userData.p.y + 0.02 * Math.max(0, Math.sin(t * 0.9 + i * 2.2)); });
      drawers.forEach((d, i) => { d.position.x = d.userData.p.x + 0.07 * Math.pow(Math.max(0, Math.sin(t * 0.45 + i * 2.1)), 4); });
      if (poster) poster.rotation.z = 0.025 * Math.sin(t * 0.9);
      if (board && !open) board.rotation.x = 0.01 * Math.sin(t * 0.7);
      starLayers[1].material.opacity = (0.5 + 0.45 * Math.sin(t * 1.7)) * (1 - day);
      // hologram
      holoCore.rotation.y -= dt * 0.6;
      const hu = t % 12;
      let hk = hu <= 8 ? 0 : hu <= 9.2 ? (hu - 8) / 1.2 : hu <= 9.8 ? 1 : 1 - (hu - 9.8) / 2.2;
      hk = hk * hk * (3 - 2 * hk);
      if (hk !== holoK) {
        if (holoK === 0 && hk > 0) sound.crumble();
        if (holoK === 1 && hk < 1) sound.rise();
        holoK = hk;
        for (let i = 0; i < HN * 3; i += 3) {
          hPos[i] = hTarget[i] + hRand[i] * 0.3 * hk;
          hPos[i + 1] = hTarget[i + 1] * (1 - hk) + (-0.28 + hRand[i + 1] * 0.015) * hk;
          hPos[i + 2] = hTarget[i + 2] + hRand[i + 2] * 0.3 * hk;
        }
        holoGeo.attributes.position.needsUpdate = true;
      }
      holoRing.rotation.x = Math.PI / 2 + 0.5 * Math.sin(t * 0.8); holoRing.rotation.z += dt * 0.6;
      holo.position.y = HOLO_Y + 0.02 * Math.sin(t * 1.5);
      holoBeam.material.opacity = 0.08 + 0.04 * Math.sin(t * 6);
      scanBars.forEach((b) => { b.position.y = b.userData.y + b.userData.travel * (0.5 - ((t * 0.22 + b.userData.offset) % 1)); });
      for (let i = 0; i < DUST; i++) {
        const [x0, y0, z0, ph, sp] = dustSeed[i];
        dustPos[i * 3] = x0 + 0.15 * Math.sin(t * sp * 0.5 + ph);
        dustPos[i * 3 + 1] = 0.15 + ((y0 + t * sp * 0.04) % 2.4);
        dustPos[i * 3 + 2] = z0 + 0.15 * Math.cos(t * sp * 0.4 + ph);
      }
      dustGeo.attributes.position.needsUpdate = true;
      if ((screenClock += dt) > 0.06) { screenClock = 0; tickScreens(t); }
      if (arcadeMesh && (arcade.clock += dt) > 0.045) { arcadeStep(arcade.clock, t); arcade.clock = 0; }
      fx.uniforms.uTime.value = t % 100;
    }
    renderer.info.reset();
    if (direct) renderer.render(scene, camera); else composer.render();
    lastCalls = renderer.info.render.calls;
    if (perfFrames > 0) cpuAcc += performance.now() - cpu0;
  }
  renderer.setAnimationLoop(frame);

  // Deterministic benchmark: renders n full frames back to back and waits for the GPU to finish them, so the
  // result is the true cost of a frame (CPU + GPU), independent of the browser's refresh pacing.
  function bench(n = 150) {
    const gl = renderer.getContext(), px = new Uint8Array(4);
    const sync = () => { gl.finish(); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    for (let i = 0; i < 12; i++) frame();
    sync();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) frame();
    sync();
    const ms = (performance.now() - t0) / n;
    perfFrames = -40; perfTime = 0; cpuAcc = 0; lowStreak = 0; // the watchdog ignores the burst
    return { msPerFrame: +ms.toFixed(2), framesPerSecondPossible: Math.round(1000 / ms), headroomVs60fps: +(16.67 / ms).toFixed(1) + 'x', tier, canvas: [canvas.width, canvas.height], drawCalls: lastCalls, textures: sfx ? '2K' : '4K' };
  }

  window.__roomDebug = { scene, room, textures: [lmA.image.width, lmB.image.width, lmC.image.width], soundTest: sound.selfTest, videos, videoScreens: 1, tube, plates: () => platesMeshes, controls, pets, vac: () => vac, rari: () => rari, tank: () => tank, wallFade, arcade, tier: () => tier, bench, chart, neon, camera, day: () => day, dayShaderOk, toggleDay, dayLoaded: () => dayReady, penguins: penguins.length, hotKeys: [...new Set(hotMeshes.map((m) => m.userData.key))] }; // handle for checks
  // the contact board is redrawn when a visitor pins a note (pop runs 0 to 1 while the new note settles)
  const redrawContact = (pop = 1) => { if (!live.contact) return; art.drawContact(live.contact.cv, live.contact.ctx, pop); live.contact.tex.needsUpdate = true; };
  return { focus, overview, toggleDay, redrawContact };
}
