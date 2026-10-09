// The landing hero: Rein as a core, the claude and codex CLIs orbiting it, and the repos of a
// workspace on an outer ring, with work flowing from the core to them. Follows the pointer, can be
// dragged, pauses off-screen, and draws a single still frame when reduced motion is asked for.
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  EdgesGeometry,
  Group,
  IcosahedronGeometry,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  QuadraticBezierCurve3,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  WebGLRenderer,
} from 'three';

const MINT = new Color('#7cf5c4');
const CORAL = new Color('#ff9b6a');
const BLUE = new Color('#7aa7ff');
const WHITE = new Color('#e8ecf2');

/** A soft round glow, drawn once into a canvas and used by every sprite and particle. */
function glowTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

type Node = {name: string; color: Color; radius: number; speed: number; phase: number; tilt: number; size: number; mesh: Mesh; halo: Sprite; label: HTMLElement; pos: Vector3};

export function startHero(canvas: HTMLCanvasElement, labels: HTMLElement): void {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({canvas, antialias: true, alpha: true, powerPreference: 'high-performance'});
  } catch {
    canvas.classList.add('no-webgl'); // CSS shows the static backdrop
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new Scene();
  const camera = new PerspectiveCamera(42, 1, 0.1, 200);
  camera.position.set(0, 0.6, 13);
  const world = new Group();
  scene.add(world);
  const glow = glowTexture();

  // The core: a slowly turning wireframe icosahedron around a bright center.
  const core = new Group();
  const ico = new LineSegments(new EdgesGeometry(new IcosahedronGeometry(1.25, 1)), new LineBasicMaterial({color: MINT, transparent: true, opacity: 0.75}));
  const inner = new Mesh(new IcosahedronGeometry(0.62, 2), new MeshBasicMaterial({color: MINT, transparent: true, opacity: 0.18, wireframe: true}));
  const coreGlow = new Sprite(new SpriteMaterial({map: glow, color: MINT, blending: AdditiveBlending, transparent: true, opacity: 0.9, depthWrite: false}));
  coreGlow.scale.setScalar(4.2);
  core.add(ico, inner, coreGlow);
  world.add(core);

  // Orbits: the two CLIs close in, the repos further out, each ring tilted its own way.
  const ring = (radius: number, tilt: number, opacity: number) => {
    const pts: Vector3[] = [];
    for (let i = 0; i <= 160; i++) {
      const a = (i / 160) * Math.PI * 2;
      pts.push(new Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius).applyAxisAngle(new Vector3(1, 0, 0), tilt));
    }
    world.add(new Line(new BufferGeometry().setFromPoints(pts), new LineBasicMaterial({color: WHITE, transparent: true, opacity})));
  };
  ring(2.9, 0.38, 0.14);
  ring(5.2, -0.22, 0.08);

  const nodes: Node[] = [];
  const addNode = (name: string, color: Color, radius: number, speed: number, phase: number, tilt: number, size: number, cls: string) => {
    const mesh = new Mesh(new SphereGeometry(size, 24, 16), new MeshBasicMaterial({color}));
    const halo = new Sprite(new SpriteMaterial({map: glow, color, blending: AdditiveBlending, transparent: true, opacity: 0.55, depthWrite: false}));
    halo.scale.setScalar(size * 7);
    world.add(mesh, halo);
    const label = document.createElement('span');
    label.className = `orb-label ${cls}`;
    label.textContent = name;
    labels.appendChild(label);
    nodes.push({name, color, radius, speed, phase, tilt, size, mesh, halo, label, pos: new Vector3()});
  };
  addNode('claude', CORAL, 2.9, 0.16, 0, 0.38, 0.17, 'cli');
  addNode('codex', BLUE, 2.9, 0.16, Math.PI, 0.38, 0.17, 'cli');
  ['api', 'web', 'billing', 'infra', 'mobile', 'shared'].forEach((r, i) => addNode(r, WHITE, 5.2, 0.05, (i / 6) * Math.PI * 2, -0.22, 0.09, 'repo'));

  // A field of faint stars for depth.
  const N = 1400;
  const stars = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 18 + Math.random() * 40;
    const t = Math.random() * Math.PI * 2;
    const p = Math.acos(2 * Math.random() - 1);
    stars.set([r * Math.sin(p) * Math.cos(t), r * Math.sin(p) * Math.sin(t) * 0.6, r * Math.cos(p)], i * 3);
  }
  const starGeo = new BufferGeometry();
  starGeo.setAttribute('position', new BufferAttribute(stars, 3));
  scene.add(new Points(starGeo, new PointsMaterial({color: WHITE, size: 0.06, transparent: true, opacity: 0.55, depthWrite: false})));

  // Work in flight: packets leaving the core for a CLI, then a repo, along curved paths.
  type Packet = {curve: QuadraticBezierCurve3; t: number; speed: number; sprite: Sprite};
  const packets: Packet[] = [];
  const packetMat = (c: Color) => new SpriteMaterial({map: glow, color: c, blending: AdditiveBlending, transparent: true, depthWrite: false});
  const launch = () => {
    const target = nodes[Math.floor(Math.random() * nodes.length)]!;
    const from = new Vector3();
    const to = target.pos.clone();
    const mid = from.clone().lerp(to, 0.5).add(new Vector3(0, 1.2 + Math.random(), 0));
    const sprite = new Sprite(packetMat(target.name === 'codex' ? BLUE : target.name === 'claude' ? CORAL : MINT));
    sprite.scale.setScalar(0.32);
    world.add(sprite);
    packets.push({curve: new QuadraticBezierCurve3(from, mid, to), t: 0, speed: 0.35 + Math.random() * 0.35, sprite});
  };

  // Pointer: the scene leans toward it; dragging turns it.
  let targetX = 0;
  let targetY = 0;
  let dragYaw = 0;
  let dragging: {x: number; yaw: number} | undefined;
  const hero = canvas.parentElement!;
  hero.addEventListener('pointermove', (e) => {
    const r = hero.getBoundingClientRect();
    targetX = ((e.clientX - r.left) / r.width - 0.5) * 2;
    targetY = ((e.clientY - r.top) / r.height - 0.5) * 2;
    if (dragging) dragYaw = dragging.yaw + (e.clientX - dragging.x) * 0.006;
  });
  canvas.addEventListener('pointerdown', (e) => {
    dragging = {x: e.clientX, yaw: dragYaw};
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', () => (dragging = undefined));

  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Wide screens: the scene sits right of the copy. Narrow ones: centered, pulled back so the outer ring fits.
    camera.position.z = w < 700 ? 17 : 13;
    world.position.x = w / h > 1.3 ? 3.4 : 0;
    world.position.y = w < 700 ? 4.2 : 0.4;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  let visible = true;
  new IntersectionObserver(([e]) => (visible = !!e?.isIntersecting)).observe(canvas);

  const v = new Vector3();
  let last = performance.now();
  let clock = 0;
  let nextPacket = 0;
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!reduced) clock += dt;
    // Ease toward the pointer.
    world.rotation.y += (targetX * 0.35 + dragYaw - world.rotation.y) * 0.04;
    world.rotation.x += (targetY * 0.12 - world.rotation.x) * 0.04;
    ico.rotation.set(clock * 0.15, clock * 0.22, 0);
    inner.rotation.set(-clock * 0.3, clock * 0.1, 0);
    coreGlow.material.opacity = 0.75 + Math.sin(clock * 2) * 0.12;

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    for (const n of nodes) {
      const a = n.phase + clock * n.speed;
      n.pos.set(Math.cos(a) * n.radius, 0, Math.sin(a) * n.radius).applyAxisAngle(new Vector3(1, 0, 0), n.tilt);
      n.mesh.position.copy(n.pos);
      n.halo.position.copy(n.pos);
      // Labels are HTML (crisp text), placed where the node lands on screen.
      v.copy(n.pos).applyMatrix4(world.matrixWorld).project(camera);
      const behind = v.z > 1;
      n.label.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
      n.label.style.opacity = behind ? '0' : String(Math.max(0.25, Math.min(1, 1.15 - v.z * 0.2)));
    }

    if (!reduced && clock > nextPacket) {
      launch();
      nextPacket = clock + 0.18 + Math.random() * 0.3;
    }
    for (let i = packets.length - 1; i >= 0; i--) {
      const p = packets[i]!;
      p.t += dt * p.speed;
      if (p.t >= 1) {
        world.remove(p.sprite);
        p.sprite.material.dispose();
        packets.splice(i, 1);
        continue;
      }
      p.curve.getPoint(p.t, p.sprite.position);
      p.sprite.material.opacity = Math.sin(p.t * Math.PI);
    }
    renderer.render(scene, camera);
  };

  if (reduced) {
    world.updateMatrixWorld();
    frame(performance.now());
    return;
  }
  const loop = (now: number) => {
    if (visible && !document.hidden) frame(now);
    else last = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
