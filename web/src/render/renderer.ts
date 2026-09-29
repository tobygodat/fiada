// Canvas renderer for the map. SVG spent most of each zoom frame in the
// browser's style, layout and paint of thousands of circles and label divs;
// here a frame is one pass over the visible nodes and the drawn edges, and
// React is only involved when the scene itself changes.
//
// The renderer owns the camera, the animation loop, pointer input and hit
// testing. Everything else (what's selected, what's open) lives in React and
// arrives through setScene.

import type { TreeActivity } from '../graph/activity.ts';
import type { Camera } from '../graph/camera.ts';
import { directZoom, easeInOut, freeArea, smoothZoom, zoomAt } from '../graph/camera.ts';
import type { Circle } from '../graph/layout.ts';
import type { TNode, Tree } from '../graph/tree.ts';
import { countKind, crossRepo, direction, kindCounts, meetingPoint, visibleNodes, type Contract, type ExpandMode, type Visible } from '../graph/view.ts';
import type { ColorBy, Palette } from '../theme.ts';
import { fonts, onThemeChange, token } from '../theme/tokens.ts';
import { type BadgeCache, drawBadges, drawRings } from './activity.ts';
import { bestBend, curve, DEFAULT_BEND, DEFAULT_EDGE_POLICY, EDGE_POLICIES, edgeScore, restEdges, type EdgePolicy, type EdgePreset } from './edges.ts';

const MAX_EDGES = 220;
const MAX_TAGS = 40;
const LABEL_MIN_R = 16;
/** Below this radius a closed circle is labelled only if its whole name fits. */
const LABEL_FULL_R = 34;
/** How strongly the rest of the map is drawn while one agent's changes are lit. */
const UNLIT = 0.22;

/**
 * Literata's sizes (DESIGN.md, Type): fine, small, body, title, display. A
 * label takes the largest one its circle has room for, and 13px is the
 * least: a small circle keeps its name only if the name (or its short form)
 * fits inside at 13px. Nothing shrinks below that to squeeze in; a name that
 * doesn't fit is left to the details panel.
 */
export const TYPE = [13, 15, 17, 20, 24] as const;
export const typeSize = (px: number) => TYPE.reduce<number>((s, t) => (t <= px ? t : s), TYPE[0]);
/** Container names are 600, leaves and everything else 400. */
type Weight = 400 | 600;

/** The inks the map draws with, read from the design tokens once a frame. */
const inks = () => ({
  ground: token('--ground'),
  raised: token('--ground-raised'),
  text: token('--text'),
  muted: token('--muted'),
  strong: token('--hairline-strong'),
  selection: token('--selection'),
  accent: token('--accent'),
});

export interface Scene {
  tree: Tree;
  L: Map<string, Circle>;
  mode: ExpandMode;
  /** Click mode: what's open. Zoom mode works it out from the camera. */
  vis: Visible | null;
  contracts: Contract[];
  pal: Palette;
  colorBy: ColorBy;
  selected: string | null;
  selectedEdge: string | null;
  /** What coding agents changed, placed on this tree (the agent overlay). */
  activity?: TreeActivity | null;
  /** One agent's changes and every circle round them, shown at full strength while the rest dims. */
  lit?: ReadonlySet<string> | null;
}

export interface RendererEvents {
  /** A click (not a drag) on a circle. */
  node(id: string, open: boolean): void;
  /** A click on an open circle's name tab. */
  tab(id: string): void;
  edge(key: string): void;
  /** A click on empty space. */
  empty(): void;
  /** Zoom mode: the set of open circles changed. */
  visible(vis: Visible): void;
  resize(w: number, h: number): void;
}

type Hit =
  | { type: 'node'; id: string; open: boolean }
  | { type: 'tab'; id: string }
  | { type: 'edge'; key: string }
  | { type: 'tag'; key: string };

interface DrawnNode {
  n: TNode;
  x: number;
  y: number;
  r: number;
  open: boolean;
  /** Drawn faint: an agent's changes are lit and this is neither one of them nor round one. */
  unlit?: boolean;
}
interface DrawnEdge {
  g: Contract;
  pts: number[];
  w: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const sameHit = (a: Hit | null, b: Hit | null): boolean => {
  if (a === b) return true;
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'edge' || a.type === 'tag') return a.key === (b as typeof a).key;
  // A circle that opens under the pointer is a different target: its edges stop being in focus.
  return a.id === (b as typeof a).id && (a.type !== 'node' || a.open === (b as typeof a).open);
};

export class MapRenderer {
  private host: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tip: HTMLDivElement;
  private ro: ResizeObserver;
  private on: RendererEvents;

  /** Pixels floating panels cover on the left and right; edge tags stay out from under them. */
  private panels = { left: 0, right: 0 };
  private w = 0;
  private h = 0;
  private dpr = 1;
  private cam: Camera = { k: 1, tx: 0, ty: 0 };
  private scene: Scene | null = null;
  private vis: Visible | null = null;
  private visIds = new Set<string>();

  private camAnim: { at: (t: number) => Camera; start: number; dur: number } | null = null;
  private layoutAnim: { from: Map<string, Circle>; start: number; dur: number } | null = null;

  private raf = 0;
  /** The agent overlay has a pulse running, so keep drawing frames. */
  private pulsing = false;
  private listeners = new Set<() => void>();
  /** The camera listeners last heard about; wheel and drag replace `cam` between frames. */
  private emitted: Camera | null = null;

  private drag: { x: number; y: number; cam: Camera; moved: boolean; id: number } | null = null;
  private pointer: { x: number; y: number } | null = null;
  private hover: Hit | null = null;

  private policy: EdgePolicy = DEFAULT_EDGE_POLICY;
  // Per layout and set of open circles: the resting edges, and which way each edge bends.
  private edgeCache: { L: Map<string, Circle>; vis: Visible; contracts: Contract[]; rest: Set<string>; bends: Map<string, number>; obstacles: Circle[] } | null = null;

  // What the last frame drew, for hit testing.
  private drawnNodes: DrawnNode[] = [];
  private drawnEdges: DrawnEdge[] = [];
  private drawnTags: (Rect & { key: string })[] = [];
  private drawnTabs: (Rect & { id: string })[] = [];
  /** Where the agent badges went last frame (activity.ts), reused while the map holds still. */
  private badgeCache: BadgeCache = {};

  private measure = document.createElement('canvas').getContext('2d')!;
  private lastFont = '';
  private serif = fonts().serif || 'Literata, Georgia, serif';
  private offTheme: () => void;
  private colors = new Map<string, string>();
  private widths = new Map<string, number>();
  private counts = new WeakMap<TNode, string | null>();

  constructor(host: HTMLElement, on: RendererEvents) {
    this.host = host;
    this.on = on;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    this.ctx = this.canvas.getContext('2d')!;
    this.tip = document.createElement('div');
    this.tip.className = 'map-tip';
    host.append(this.canvas, this.tip);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();

    host.addEventListener('wheel', this.onWheel, { passive: false });
    host.addEventListener('pointerdown', this.onDown);
    host.addEventListener('pointermove', this.onMove);
    host.addEventListener('pointerup', this.onUp);
    host.addEventListener('pointercancel', this.onCancel);
    host.addEventListener('pointerleave', this.onLeave);
    // Labels are measured in Literata; re-measure once it arrives. The canvas
    // alone doesn't make the browser fetch a web font, so ask for both weights.
    const remeasure = () => {
      this.widths.clear();
      this.lastFont = '';
      this.request();
    };
    document.fonts?.ready.then(remeasure);
    if (document.fonts) Promise.all([400, 600].map((wt) => document.fonts.load(`${wt} 15px ${this.serif}`))).then(remeasure, () => {});
    // The palettes are tokens, so a theme switch is a repaint.
    this.offTheme = onThemeChange(() => {
      this.colors.clear();
      this.request();
    });
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.offTheme();
    this.host.removeEventListener('wheel', this.onWheel);
    this.host.removeEventListener('pointerdown', this.onDown);
    this.host.removeEventListener('pointermove', this.onMove);
    this.host.removeEventListener('pointerup', this.onUp);
    this.host.removeEventListener('pointercancel', this.onCancel);
    this.host.removeEventListener('pointerleave', this.onLeave);
    this.canvas.remove();
    this.tip.remove();
  }

  // ── scene and camera ──

  /** New scene. Pass `from` (the previous layout) to animate circles into their new places. */
  setScene(scene: Scene, from?: Map<string, Circle>, duration = 520) {
    const prev = this.scene;
    if (prev && (prev.pal !== scene.pal || prev.colorBy !== scene.colorBy)) this.colors.clear();
    if (prev?.tree !== scene.tree) this.counts = new WeakMap();
    this.scene = scene;
    // Animate only when this scene is what changed the layout (from may be stale otherwise).
    if (prev?.L !== scene.L) this.layoutAnim = from && prev?.tree === scene.tree && prev.L === from ? { from, start: performance.now(), dur: duration } : null;
    if (scene.mode === 'click') this.setVis(scene.vis);
    else if (prev?.mode !== 'zoom' || prev.L !== scene.L) this.vis = null; // recomputed from the camera next frame
    this.request();
  }

  setPanels(left: number, right: number) {
    if (left === this.panels.left && right === this.panels.right) return;
    this.panels = { left, right };
    this.request();
  }

  private free() {
    const f = freeArea({ w: this.w, h: this.h, ...this.panels });
    return { x0: f.cx - f.w / 2 + 12, x1: f.cx + f.w / 2 - 12, y0: 12, y1: this.h - 12 };
  }

  get camera(): Camera {
    return this.cam;
  }

  /** Subscribe to camera changes, however they happen (for the zoom readout and breadcrumb). */
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  setCamera(cam: Camera) {
    this.camAnim = null;
    this.cam = cam;
    this.request();
  }

  /**
   * Move the camera. `smooth` zooms out and back in on long trips (for
   * navigating to something far away); `direct` goes straight there, for
   * moves that happen while the layout itself is animating.
   */
  animateTo(target: Camera, how: 'smooth' | 'direct' = 'smooth', duration?: number) {
    const anchor = { x: this.w / 2, y: this.h / 2 };
    if (how === 'smooth') {
      const z = smoothZoom(this.cam, target, anchor, Math.min(this.w, this.h) || 1);
      const dur = duration ?? Math.max(350, Math.min(1100, z.duration * 0.9));
      this.camAnim = { at: z.interpolate, start: performance.now(), dur };
    } else {
      this.camAnim = { at: directZoom(this.cam, target, anchor), start: performance.now(), dur: duration ?? 520 };
    }
    this.request();
  }

  // ── frame loop ──

  private request() {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.raf = 0;
    let more = false;
    if (this.camAnim) {
      const t = Math.min(1, (now - this.camAnim.start) / this.camAnim.dur);
      this.cam = this.camAnim.at(easeInOut(t));
      if (t >= 1) this.camAnim = null;
      else more = true;
    }
    let lt = 1;
    if (this.layoutAnim) {
      lt = Math.min(1, (now - this.layoutAnim.start) / this.layoutAnim.dur);
      if (lt >= 1) this.layoutAnim = null;
      else more = true;
    }
    this.draw(easeInOut(lt));
    if (this.pulsing) more = true;
    if (this.emitted !== this.cam) {
      this.emitted = this.cam;
      for (const fn of this.listeners) fn();
    }
    // Whatever is under a resting pointer may have moved or changed.
    if (this.pointer && !this.drag?.moved) this.setHover(this.hitTest(this.pointer.x, this.pointer.y));
    if (more) this.request();
  };

  private resize() {
    const r = this.host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (r.width === this.w && r.height === this.h && dpr === this.dpr) return;
    this.w = r.width;
    this.h = r.height;
    this.dpr = dpr;
    this.lastFont = ''; // resizing a canvas resets its context state
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.on.resize(r.width, r.height);
    this.request();
  }

  private setVis(vis: Visible | null) {
    if (vis === this.vis) return;
    this.vis = vis;
    this.visIds = new Set(vis?.list.map((n) => n.id));
  }

  // ── drawing ──

  private color(kind: 'repo' | 'layer' | 'neutral', id: string | undefined, a: number) {
    const key = `${kind}|${id}|${a}`;
    let c = this.colors.get(key);
    if (!c) {
      const pal = this.scene!.pal;
      c = kind === 'repo' ? pal.repo(id!, a) : kind === 'layer' ? pal.layer(id, a) : pal.neutral(a);
      this.colors.set(key, c);
    }
    return c;
  }

  private nodeColor(n: TNode, a: number) {
    if (this.scene!.colorBy === 'layer') return n.layer ? this.color('layer', n.layer, a) : this.color('neutral', undefined, a);
    return n.repo ? this.color('repo', n.repo, a) : this.color('neutral', undefined, a);
  }

  /** Sets the drawing font, skipping the (costly) assignment when it hasn't changed. */
  private font(weight: Weight, size: number) {
    const f = `${weight} ${size}px ${this.serif}`;
    if (f !== this.lastFont) this.ctx.font = this.lastFont = f;
  }

  /**
   * Text width, measured once per string and size. Literata changes its
   * shapes with size (the optical-size axis), so a width at one size doesn't
   * scale to another; there are only five sizes to measure at.
   */
  private textWidth(text: string, weight: Weight, size: number) {
    const key = `${weight}|${size}|${text}`;
    let w = this.widths.get(key);
    if (w == null) {
      // A separate context, so measuring never changes the font being drawn with.
      this.measure.font = `${weight} ${size}px ${this.serif}`;
      w = this.measure.measureText(text).width;
      this.widths.set(key, w);
    }
    return w;
  }

  private fit(text: string, weight: Weight, size: number, max: number) {
    if (this.textWidth(text, weight, size) <= max) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.textWidth(text.slice(0, mid) + '…', weight, size) <= max) lo = mid;
      else hi = mid - 1;
    }
    return lo ? text.slice(0, lo) + '…' : '';
  }

  /** Up to two lines, word-wrapped, the second ellipsised. */
  private wrap2(text: string, weight: Weight, size: number, max: number): string[] {
    if (this.textWidth(text, weight, size) <= max) return [text];
    const words = text.split(/(?<=[\s._/-])/);
    let line = '';
    let i = 0;
    for (; i < words.length; i++) {
      const next = line + words[i];
      if (line && this.textWidth(next, weight, size) > max) break;
      line = next;
    }
    if (i >= words.length) return [this.fit(line, weight, size, max)];
    return [this.fit(line.trimEnd(), weight, size, max), this.fit(words.slice(i).join(''), weight, size, max)];
  }

  private subtitle(n: TNode): string | null {
    if (this.counts.has(n)) return this.counts.get(n)!;
    let s: string | null = null;
    const plural = (c: number, w: string) => `${c} ${w}${c === 1 ? '' : 's'}`;
    if (n.kind === 'repo') s = `${plural(countFiles(n), 'file')} · ${plural(n.symbols, 'symbol')}`;
    else if (n.kind === 'domain') {
      const repos = new Set<string>();
      const walk = (x: TNode) => (x.repo ? repos.add(x.repo) : x.children.forEach(walk));
      walk(n);
      s = `${plural(n.symbols, 'symbol')} · ${plural(repos.size, 'repo')}`;
    } else if (n.kind === 'folder') s = plural(countFiles(n), 'file');
    else if ((n.kind === 'file' || n.kind === 'layer') && n.children.length) s = plural(n.children.length, 'symbol');
    this.counts.set(n, s);
    return s;
  }

  private draw(lt: number) {
    const { ctx, w, h } = this;
    const ink = inks();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // The map's paper: flat, no gradient.
    ctx.clearRect(0, 0, w, h);
    if (ink.ground) {
      ctx.fillStyle = ink.ground;
      ctx.fillRect(0, 0, w, h);
    }
    this.drawnNodes = [];
    this.drawnEdges = [];
    this.drawnTags = [];
    this.drawnTabs = [];
    this.pulsing = false;
    const scene = this.scene;
    if (!scene || !w) return;
    const { tree, L } = scene;
    const { k, tx, ty } = this.cam;

    if (scene.mode === 'zoom') {
      const vis = visibleNodes(tree, L, this.cam, w, h);
      if (!this.vis || vis.key !== this.vis.key) {
        this.setVis(vis);
        this.on.visible(vis);
      }
    }
    const vis = this.vis;
    if (!vis) return;

    // Circles, mid-animation when the layout just changed.
    const anim = this.layoutAnim;
    const at: (id: string) => Circle | undefined = anim ? animatedCircles(tree, L, anim.from, lt) : (id) => L.get(id);

    // Selection stands in at its nearest visible ancestor.
    let sv: string | null = scene.selected;
    while (sv && !this.visIds.has(sv)) sv = tree.nodes.get(sv)?.parent ?? null;

    const toScreen = (c: Circle) => ({ x: tx + c.x * k, y: ty + c.y * k, r: c.r * k });
    const onScreen = (s: { x: number; y: number; r: number }) => s.x + s.r > 0 && s.x - s.r < w && s.y + s.r > 0 && s.y - s.r < h;

    // ── edges ──
    // At rest only each open circle's few strongest contracts are drawn.
    // Pointing at a closed circle, or selecting one, brings in the strongest
    // of the contracts that cross its rim; its panel lists the rest. An open
    // circle is a place you're in, not something in focus, so selecting it
    // draws nothing extra.
    const selKey = scene.selectedEdge;
    const anyEdgeSel = !!selKey && scene.contracts.some((c) => c.key === selKey);
    const hoverNode = this.hover?.type === 'node' && !this.hover.open ? this.hover.id : null;
    const fv = hoverNode ?? (sv && !vis.open.has(sv) ? sv : null);
    const within = this.within(fv);
    const rest = this.restSet(scene);
    const hoverKey = this.hover?.type === 'edge' || this.hover?.type === 'tag' ? this.hover.key : null;
    let focusEdges: { g: Contract; A: Circle; B: Circle; role: 'focus' | 'sel' | 'rest' }[] = [];
    const resting: typeof focusEdges = [];
    for (const g of scene.contracts) {
      if (!this.visIds.has(g.a) || !this.visIds.has(g.b)) continue;
      const touches = !!fv && within(g.a) !== within(g.b);
      const role = g.key === selKey ? 'sel' : touches ? 'focus' : rest.has(g.key) ? 'rest' : null;
      if (!role) continue;
      const A = at(g.a);
      const B = at(g.b);
      if (!A || !B) continue;
      const sa = toScreen(A);
      const sb = toScreen(B);
      // A resting edge between two places off screen says nothing about what's on it.
      if (!onScreen(sa) && !onScreen(sb) && (role === 'rest' || !segmentOnScreen(sa, sb, w, h))) continue;
      (role === 'rest' ? resting : focusEdges).push({ g, A, B, role });
    }
    if (focusEdges.length > this.policy.focusMax) {
      // The selected contract always stays.
      const score = (e: (typeof focusEdges)[number]) => (e.role === 'sel' ? Infinity : edgeScore(e.g, this.policy.boost));
      focusEdges.sort((p, q) => score(q) - score(p));
      focusEdges = focusEdges.slice(0, Math.max(this.policy.focusMax, selKey && focusEdges[0].g.key === selKey ? 1 : 0));
    }
    // Rest edges underneath, the ones in focus on top.
    const drawn = [...resting, ...focusEdges.slice(0, MAX_EDGES)];
    const inFocus = focusEdges.length > 0 || anyEdgeSel;
    const heaviest = Math.max(1, ...drawn.map((e) => e.g.items.length));
    const lit = scene.lit?.size ? scene.lit : null;
    // While an agent's changes are lit, a resting link stays in full only if both its ends are lit.
    const unlitEdge = (g: Contract) => !!lit && !(lit.has(g.a) && lit.has(g.b));
    const tagQueue: { g: Contract; pts: [number, number, number, number, number, number]; isSel: boolean }[] = [];
    const tagBox = this.free();
    ctx.lineCap = 'round';
    drawn.forEach(({ g, A, B, role }, i) => {
      const bend = this.bend(scene, g);
      const c = curve(toScreen(A), toScreen(B), bend);
      const { x1, y1, mx, my, x2, y2 } = c;
      const isSel = role === 'sel';
      const isHover = g.key === hoverKey;
      const n = g.items.length;
      // Every interaction behind it was guessed: dotted, and a little fainter.
      const guess = g.inferred === n;
      // Links are --muted, --text when selected or pointed at; their ends' colours stay on the circles.
      const stroke = isSel || isHover ? ink.text : ink.muted;
      const cross = crossRepo(g);
      let op = role === 'rest' ? (inFocus ? this.policy.restFade : cross ? 0.75 : 0.6) : isSel ? 1 : anyEdgeSel ? 0.25 : 0.85;
      if (guess && !isSel) op *= 0.8;
      if (isHover && !isSel) op = Math.max(op, 0.75);
      if (role === 'rest' && !isHover && unlitEdge(g)) op *= UNLIT;
      // Width follows the log of the number of interactions, relative to the heaviest on screen.
      const sw = 1 + 4.5 * (Math.log(n) / Math.log(Math.max(2, heaviest))) + (isSel ? 0.5 : 0);
      ctx.globalAlpha = op;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = sw;
      ctx.setLineDash(guess ? [0.5, 3 + sw] : cross ? [6, 5] : []);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.quadraticCurveTo(mx, my, x2, y2);
      ctx.stroke();
      this.drawnEdges.push({
        g,
        pts: [x1, y1, mx, my, x2, y2],
        w: sw,
        minX: Math.min(x1, mx, x2),
        minY: Math.min(y1, my, y2),
        maxX: Math.max(x1, mx, x2),
        maxY: Math.max(y1, my, y2),
      });
      // Tags on what's in focus and the edge under the pointer; on the resting overview only if the policy asks.
      const tagged = isSel || isHover || (role === 'focus' ? i - resting.length < MAX_TAGS : this.policy.restTags && !inFocus && i < MAX_TAGS);
      if (tagged && c.gap > 36) tagQueue.push({ g, pts: [x1, y1, mx, my, x2, y2], isSel });
    });
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // ── circles ──
    const hoverId = this.hover?.type === 'node' ? this.hover.id : null;
    for (const n of vis.list) {
      const c = at(n.id);
      if (!c) continue;
      const s = toScreen(c);
      if (s.r < 0.6 || !onScreen(s)) continue;
      const isOpen = vis.open.has(n.id);
      const leaf = n.kind === 'symbol' || (n.kind === 'file' && !n.children.length);
      const sel = n.id === sv;
      const hovered = n.id === hoverId;
      // One agent's changes lit: the rest of the map steps back, and each closed circle holding one takes an ink rim.
      const unlit = !!lit && !lit.has(n.id);
      const marked = !!lit && !unlit && !isOpen;
      // Fade in circles that are new in this layout.
      ctx.globalAlpha = (anim && !anim.from.has(n.id) ? lt : 1) * (unlit && !sel && !hovered ? UNLIT : 1);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      // A closed circle is its colour at 12% (a leaf at 30%) inside a rim of the colour itself. An open
      // one is a place you're in, drawn as its rim alone. Selected: an ink rim over the selection fill.
      if (!isOpen) {
        ctx.fillStyle = sel ? ink.selection : this.nodeColor(n, leaf ? 0.3 : 0.12);
        ctx.fill();
      }
      ctx.lineWidth = sel ? 2 : hovered || marked ? 1.5 : 1;
      ctx.strokeStyle = sel || hovered || marked ? ink.text : this.nodeColor(n, isOpen ? 0.45 : 0.85);
      ctx.stroke();
      this.drawnNodes.push({ n, x: s.x, y: s.y, r: s.r, open: isOpen, unlit: unlit && !sel && !hovered });
    }
    ctx.globalAlpha = 1;
    if (scene.activity?.size) this.pulsing = drawRings(ctx, this.drawnNodes, scene.activity, Date.now());

    // ── labels ──
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const hoverTab = this.hover?.type === 'tab' ? this.hover.id : null;
    for (const d of this.drawnNodes) {
      const { n, x, y, r } = d;
      const big = n.kind === 'repo' || n.kind === 'domain';
      // Names of unlit circles stay just readable.
      const nameAlpha = d.unlit ? UNLIT + 0.18 : 1;
      ctx.globalAlpha = nameAlpha;
      if (d.open) {
        // An open circle's name sits in a gap cut from its rim, then "−" to close it (click mode).
        // Pointing at it turns the words green, as a pointed-at word does.
        const size = big ? 17 : 15;
        const collapse = scene.mode === 'click';
        const name = this.fit(n.name, 600, size, 300);
        const nw = this.textWidth(name, 600, size);
        const mw = collapse ? 6 + this.textWidth('−', 400, size) : 0;
        const bh = Math.round(size * 1.3) + 4;
        const bw = Math.round(nw + mw + 16);
        const bx = Math.round(x - bw / 2);
        const by = Math.round(y - r - bh / 2);
        if (by + bh < 0 || by > h || bx + bw < 0 || bx > w) continue;
        const hot = n.id === hoverTab;
        // The gap in the rim is cut in full, whatever strength the name is drawn at.
        ctx.globalAlpha = 1;
        ctx.fillStyle = ink.ground;
        ctx.fillRect(bx, by, bw, bh);
        ctx.globalAlpha = nameAlpha;
        ctx.textAlign = 'left';
        this.font(600, size);
        ctx.fillStyle = hot ? ink.accent : ink.text;
        ctx.fillText(name, bx + 8, by + bh / 2 + 0.5);
        if (collapse) {
          this.font(400, size);
          ctx.fillStyle = hot ? ink.accent : ink.muted;
          ctx.fillText('−', bx + 8 + nw + 6, by + bh / 2 + 0.5);
        }
        ctx.textAlign = 'center';
        this.drawnTabs.push({ id: n.id, x: bx, y: by, w: bw, h: bh });
      } else if (r > LABEL_MIN_R) {
        // Containers' names in 600, leaves' in 400, at the largest size of the scale the circle has room for.
        // Small circles get 13px, and the fitting below decides whether the name is drawn at all.
        const weight: Weight = n.children.length ? 600 : 400;
        const size = typeSize(r * (big ? 0.24 : 0.2));
        const max = r * 1.8;
        const lines = big ? this.wrap2(n.name, weight, size, max) : [this.fit(n.name, weight, size, max)];
        if (!big && r < LABEL_FULL_R && lines[0] !== n.name) {
          // A small circle with a clipped name ("lin…") says nothing. Try a file without its extension, or
          // the last part of a folder path ("react-email" for "packages/react-email"); else leave it to the details panel.
          const short = n.kind === 'file' ? n.name.replace(/\.[^.]+$/, '') : n.name.slice(n.name.lastIndexOf('/') + 1);
          if (!short || short === n.name || this.textWidth(short, weight, size) > max) continue;
          lines[0] = short;
        }
        if (!lines[0]) continue;
        const subSize = size >= 20 ? 15 : 13;
        // The counts under the name, whole or just their first part ("284 symbols"), never clipped.
        let sub = (big && r > 48) || (!big && r > 44) ? this.subtitle(n) : null;
        if (sub && this.textWidth(sub, 400, subSize) > max) sub = sub.split(' · ')[0];
        if (sub && this.textWidth(sub, 400, subSize) > max) sub = null;
        const lh = Math.round(size * 1.3);
        const total = lines.length * lh + (sub ? subSize * 1.5 : 0);
        let cy = y - total / 2 + lh / 2;
        ctx.fillStyle = n.id === hoverId ? ink.accent : ink.text;
        this.font(weight, size);
        for (const line of lines) {
          ctx.fillText(line, x, cy);
          cy += lh;
        }
        if (sub) {
          ctx.fillStyle = ink.muted;
          this.font(400, subSize);
          ctx.fillText(sub, x, cy - lh / 2 + subSize * 0.8);
        }
      }
    }
    ctx.globalAlpha = 1;

    // ── edge tags ──
    // Mid-curve, or the nearest point along it that isn't off screen, under a
    // panel or on top of another tag. The selected and hovered links go first.
    // Each is fine Literata in a small box on the raised ground; selected, it
    // takes the selection fill.
    this.font(400, 13);
    const first = (t: (typeof tagQueue)[number]) => (t.isSel ? 0 : t.g.key === hoverKey ? 1 : 2);
    tagQueue.sort((p, q) => first(p) - first(q));
    for (const t of tagQueue) {
      const isHover = t.g.key === hoverKey;
      const label = t.g.tag;
      const tw = Math.round(Math.max(22, this.textWidth(label, 400, 13) + 14));
      const box = (p: { x: number; y: number }) => ({ x: Math.round(p.x - tw / 2), y: Math.round(p.y - 11), w: tw, h: 22 });
      const clear = (p: { x: number; y: number }) => {
        const b = box(p);
        return !this.drawnTags.some((o) => b.x < o.x + o.w + 3 && o.x < b.x + b.w + 3 && b.y < o.y + o.h + 2 && o.y < b.y + b.h + 2);
      };
      const half = { w: tw / 2, h: 11 };
      const at = tagPoint(...t.pts, tagBox, half, clear) ?? (t.isSel || isHover ? tagPoint(...t.pts, tagBox, half) : null);
      if (!at) continue;
      const r = box(at);
      ctx.globalAlpha = t.isSel || !anyEdgeSel ? 1 : 0.3;
      ctx.fillStyle = t.isSel ? ink.selection : ink.raised;
      ctx.strokeStyle = t.isSel || isHover ? ink.text : ink.strong;
      ctx.lineWidth = 1;
      roundRect(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = t.isSel || isHover ? ink.text : ink.muted;
      ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 0.5);
      this.drawnTags.push({ ...r, key: t.g.key });
    }
    ctx.globalAlpha = 1;

    // ── agent badges, last so they can keep clear of every link, tag and tab ──
    if (scene.activity?.size) {
      const taken = { edges: this.drawnEdges, rects: [...this.drawnTags, ...this.drawnTabs], free: tagBox, view: { w, h } };
      drawBadges(ctx, this.drawnNodes, scene.activity, taken, this.badgeCache);
      this.lastFont = '';
    }
  }

  /** How much of the web to draw: a preset name, or individual settings over the current ones. */
  setEdgePolicy(p: EdgePreset | Partial<EdgePolicy>) {
    this.policy = typeof p === 'string' ? (EDGE_POLICIES[p] ?? DEFAULT_EDGE_POLICY) : { ...this.policy, ...p };
    this.edgeCache = null;
    this.request();
  }

  get edgePolicy(): EdgePolicy {
    return this.policy;
  }

  private edges(scene: Scene) {
    const vis = this.vis!;
    let c = this.edgeCache;
    if (!c || c.L !== scene.L || c.vis !== vis || c.contracts !== scene.contracts) {
      // Closed circles are what an edge shouldn't run through; open ones are regions it may cross.
      const obstacles: Circle[] = [];
      for (const n of vis.list) {
        const o = scene.L.get(n.id);
        if (o && !vis.open.has(n.id)) obstacles.push(o);
      }
      c = this.edgeCache = { L: scene.L, vis, contracts: scene.contracts, rest: restEdges(scene.contracts, this.visIds, this.policy, (g) => meetingPoint(scene.tree, g.a, g.b)), bends: new Map(), obstacles };
    }
    return c;
  }

  /** Whether a node sits inside `id` (or is it). */
  private within(id: string | null): (n: string) => boolean {
    const tree = this.scene!.tree;
    const memo = new Map<string, boolean>();
    return (n) => {
      if (!id) return false;
      let hit = memo.get(n);
      if (hit == null) {
        let cur: string | null = n;
        while (cur && cur !== id) cur = tree.nodes.get(cur)?.parent ?? null;
        memo.set(n, (hit = cur === id));
      }
      return hit;
    };
  }

  private restSet(scene: Scene): Set<string> {
    return this.edges(scene).rest;
  }

  /** Worked out on the final layout, so an edge keeps its shape while circles animate into place. */
  private bend(scene: Scene, g: Contract): number {
    const c = this.edges(scene);
    let b = c.bends.get(g.key);
    if (b == null) {
      const A = scene.L.get(g.a);
      const B = scene.L.get(g.b);
      b = A && B && this.policy.route ? bestBend(A, B, c.obstacles) : DEFAULT_BEND;
      c.bends.set(g.key, b);
    }
    return b;
  }

  /** Where `id` was last drawn on screen, if it was. */
  where(id: string): { x: number; y: number; r: number } | null {
    const d = this.drawnNodes.find((n) => n.n.id === id);
    return d ? { x: d.x, y: d.y, r: d.r } : null;
  }

  /** Where a contract's tag (or, without one, the middle of its curve) was last drawn. */
  whereContract(key: string): { x: number; y: number } | null {
    const t = this.drawnTags.find((r) => r.key === key);
    if (t) return { x: t.x + t.w / 2, y: t.y + t.h / 2 };
    const e = this.drawnEdges.find((d) => d.g.key === key);
    if (!e) return null;
    const [x1, y1, cx, cy, x2, y2] = e.pts;
    return { x: 0.25 * x1 + 0.5 * cx + 0.25 * x2, y: 0.25 * y1 + 0.5 * cy + 0.25 * y2 };
  }

  // ── hit testing ──

  hitTest(x: number, y: number): Hit | null {
    const inRect = (r: Rect) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    for (let i = this.drawnTags.length - 1; i >= 0; i--) if (inRect(this.drawnTags[i])) return { type: 'tag', key: this.drawnTags[i].key };
    for (let i = this.drawnTabs.length - 1; i >= 0; i--) if (inRect(this.drawnTabs[i])) return { type: 'tab', id: this.drawnTabs[i].id };
    // Closed circles and leaves first (deepest wins), then edges, then the open circles they sit in.
    let openHit: DrawnNode | null = null;
    for (let i = this.drawnNodes.length - 1; i >= 0; i--) {
      const d = this.drawnNodes[i];
      const dx = x - d.x;
      const dy = y - d.y;
      if (dx * dx + dy * dy > d.r * d.r) continue;
      if (!d.open) return { type: 'node', id: d.n.id, open: false };
      openHit ??= d;
    }
    let best: DrawnEdge | null = null;
    let bestD = Infinity;
    for (const e of this.drawnEdges) {
      const tol = Math.max(6, e.w / 2 + 4);
      if (x < e.minX - tol || x > e.maxX + tol || y < e.minY - tol || y > e.maxY + tol) continue;
      const dist = distToQuad(x, y, e.pts);
      if (dist <= tol && dist < bestD) {
        best = e;
        bestD = dist;
      }
    }
    if (best) return { type: 'edge', key: best.g.key };
    return openHit ? { type: 'node', id: openHit.n.id, open: true } : null;
  }

  // ── input ──

  private local(e: { clientX: number; clientY: number }) {
    const r = this.host.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const { x, y } = this.local(e);
    // Trackpad pinches arrive as ctrl+wheel with small deltas.
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.camAnim = null;
    this.cam = zoomAt(this.cam, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0016)), x, y);
    this.request();
  };

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const { x, y } = this.local(e);
    this.drag = { x, y, cam: this.cam, moved: false, id: e.pointerId };
  };

  private onMove = (e: PointerEvent) => {
    const p = this.local(e);
    this.pointer = p;
    const d = this.drag;
    if (d && (e.buttons & 1 || e.pointerType !== 'mouse')) {
      const dx = p.x - d.x;
      const dy = p.y - d.y;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) {
        d.moved = true;
        this.camAnim = null;
        try {
          this.host.setPointerCapture(d.id);
        } catch {
          // synthetic events have no capturable pointer
        }
        this.setHover(null);
        this.host.style.cursor = 'grabbing';
      }
      if (d.moved) {
        this.cam = { k: d.cam.k, tx: d.cam.tx + dx, ty: d.cam.ty + dy };
        this.request();
      }
      return;
    }
    this.setHover(this.hitTest(p.x, p.y));
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const { x, y } = this.local(e);
    const hit = this.hitTest(x, y);
    if (d.moved) {
      this.host.style.cursor = '';
      return this.setHover(hit);
    }
    if (!hit) return this.on.empty();
    if (hit.type === 'node') this.on.node(hit.id, hit.open);
    else if (hit.type === 'tab') this.on.tab(hit.id);
    else this.on.edge(hit.key);
  };

  private onCancel = () => {
    this.drag = null;
    this.host.style.cursor = '';
  };

  private onLeave = () => {
    if (!this.drag) this.setHover(null);
    this.pointer = null;
  };

  private setHover(hit: Hit | null) {
    if (sameHit(hit, this.hover)) {
      if (hit && this.pointer) this.placeTip();
      return;
    }
    this.hover = hit;
    this.host.style.cursor = hit ? 'pointer' : '';
    const text = hit ? this.describe(hit) : '';
    this.tip.textContent = text;
    this.tip.style.display = text ? 'block' : 'none';
    if (text) this.placeTip();
    this.request();
  }

  private placeTip() {
    if (!this.pointer) return;
    // Kept out from under the side panels, like the tags.
    const f = this.free();
    const x = Math.max(f.x0, Math.min(this.pointer.x + 14, f.x1 - this.tip.offsetWidth - 8));
    const y = this.pointer.y + 18 + this.tip.offsetHeight > f.y1 ? this.pointer.y - this.tip.offsetHeight - 10 : this.pointer.y + 18;
    this.tip.style.transform = `translate(${x}px, ${y}px)`;
  }

  private describe(hit: Hit): string {
    const scene = this.scene;
    if (!scene) return '';
    if (hit.type === 'edge' || hit.type === 'tag') {
      const c = scene.contracts.find((g) => g.key === hit.key);
      if (!c) return '';
      const [from, to, both] = direction(c);
      const A = scene.tree.nodes.get(from)?.name;
      const B = scene.tree.nodes.get(to)?.name;
      const kinds = kindCounts(c)
        .map(([kind, n]) => countKind(kind, n))
        .join(', ');
      const guessed = !c.inferred ? '' : c.inferred === c.items.length ? ' · inferred' : ` · ${c.inferred} inferred`;
      const cross = !c.cross ? '' : c.cross === c.items.length ? ' · cross-repo' : ` · ${c.cross} cross-repo`;
      return `${A} ${both ? '⇄' : '→'} ${B} · ${kinds}${cross}${guessed}`;
    }
    // Circles and their name tabs say nothing on hover; the details panel has it on click.
    return '';
  }
}

/**
 * Circle positions part-way through a layout change. Circles that were
 * already on screen slide to their new place; new ones ride along inside
 * their parent as it grows, so opening a circle reads as it unfolding.
 */
function animatedCircles(tree: Tree, to: Map<string, Circle>, from: Map<string, Circle>, t: number) {
  const cache = new Map<string, Circle>();
  const get = (id: string): Circle | undefined => {
    const hit = cache.get(id);
    if (hit) return hit;
    const b = to.get(id);
    if (!b) return undefined;
    const a = from.get(id);
    let c: Circle;
    if (a) c = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, r: a.r + (b.r - a.r) * t };
    else {
      const pid = tree.nodes.get(id)?.parent;
      const p = pid ? get(pid) : undefined;
      const pb = pid ? to.get(pid) : undefined;
      if (p && pb && pb.r > 0) {
        const s = p.r / pb.r;
        c = { x: p.x + (b.x - pb.x) * s, y: p.y + (b.y - pb.y) * s, r: b.r * s };
      } else c = b;
    }
    cache.set(id, c);
    return c;
  };
  return get;
}

function countFiles(n: TNode): number {
  if (n.kind === 'file') return 1;
  let c = 0;
  for (const ch of n.children) c += countFiles(ch);
  return c;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Whether the segment between two circle centres crosses the screen (both ends can be off it). */
function segmentOnScreen(a: { x: number; y: number }, b: { x: number; y: number }, w: number, h: number) {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  return maxX > 0 && minX < w && maxY > 0 && minY < h;
}

/**
 * Where on a curve to put its tag: the middle if a tag of half-size `half`
 * fits inside `box` there, else the fitting point nearest the middle.
 */
function tagPoint(
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  x2: number,
  y2: number,
  box: { x0: number; x1: number; y0: number; y1: number },
  half: { w: number; h: number },
  ok: (p: { x: number; y: number }) => boolean = () => true,
) {
  const at = (t: number) => {
    const u = 1 - t;
    return { x: u * u * x1 + 2 * u * t * cx + t * t * x2, y: u * u * y1 + 2 * u * t * cy + t * t * y2 };
  };
  const inside = (p: { x: number; y: number }) =>
    p.x - half.w >= box.x0 && p.x + half.w <= box.x1 && p.y - half.h >= box.y0 && p.y + half.h <= box.y1;
  for (let step = 0; step <= 7; step++) {
    for (const t of step ? [0.5 - step * 0.05, 0.5 + step * 0.05] : [0.5]) {
      const p = at(t);
      if (inside(p) && ok(p)) return p;
    }
  }
  return null;
}

/** Distance from (x, y) to a quadratic Bézier, by sampling it into short segments. */
function distToQuad(x: number, y: number, [x1, y1, cx, cy, x2, y2]: number[]) {
  let best = Infinity;
  let px = x1;
  let py = y1;
  const N = 16;
  for (let i = 1; i <= N; i++) {
    const t = i / N;
    const u = 1 - t;
    const qx = u * u * x1 + 2 * u * t * cx + t * t * x2;
    const qy = u * u * y1 + 2 * u * t * cy + t * t * y2;
    best = Math.min(best, distToSegment(x, y, px, py, qx, qy));
    px = qx;
    py = qy;
  }
  return best;
}

function distToSegment(x: number, y: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / l2)) : 0;
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}
