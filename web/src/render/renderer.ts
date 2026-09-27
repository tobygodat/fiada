// Canvas renderer for the map. SVG spent most of each zoom frame in the
// browser's style, layout and paint of thousands of circles and label divs;
// here a frame is one pass over the visible nodes and the drawn edges, and
// React is only involved when the scene itself changes.
//
// The renderer owns the camera, the animation loop, pointer input and hit
// testing. Everything else (what's selected, what's open) lives in React and
// arrives through setScene.

import { describeMarks, type TreeActivity } from '../graph/activity.ts';
import type { Camera } from '../graph/camera.ts';
import { directZoom, easeInOut, freeArea, smoothZoom, zoomAt } from '../graph/camera.ts';
import type { Circle } from '../graph/layout.ts';
import type { TNode, Tree } from '../graph/tree.ts';
import { visibleNodes, type Contract, type ExpandMode, type Visible } from '../graph/view.ts';
import { BG, INK, MONO, SANS, type ColorBy, type Palette } from '../theme.ts';
import { type BadgeCache, drawBadges, drawRings } from './activity.ts';
import { bestBend, curve, DEFAULT_BEND, DEFAULT_EDGE_POLICY, EDGE_POLICIES, restEdges, type EdgePolicy, type EdgePreset } from './edges.ts';

const MAX_EDGES = 220;
const MAX_TAGS = 40;
const LABEL_MIN_R = 16;
/** Below this radius a closed circle is labelled only if its whole name fits. */
const LABEL_FULL_R = 34;

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
    // Labels are measured in the web fonts; re-measure once they arrive.
    document.fonts?.ready.then(() => {
      this.widths.clear();
      this.request();
    });
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
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

  /** Subscribe to camera changes (for the zoom readout). */
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
    const before = this.cam;
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
    if (before !== this.cam) for (const fn of this.listeners) fn();
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
  private font(family: 'mono' | 'mono-medium' | 'sans-bold', size: number) {
    const f = family === 'mono' ? `400 ${size}px ${MONO}` : family === 'mono-medium' ? `500 ${size}px ${MONO}` : `600 ${size}px ${SANS}`;
    if (f !== this.lastFont) this.ctx.font = this.lastFont = f;
  }

  /** Text width at `size` px, measured once per string at 100px. */
  private textWidth(text: string, family: 'mono' | 'sans-bold', size: number) {
    const key = `${family}|${text}`;
    let w = this.widths.get(key);
    if (w == null) {
      // A separate context, so measuring never changes the font being drawn with.
      this.measure.font = family === 'mono' ? `400 100px ${MONO}` : `600 100px ${SANS}`;
      w = this.measure.measureText(text).width;
      this.widths.set(key, w);
    }
    return (w * size) / 100;
  }

  private fit(text: string, family: 'mono' | 'sans-bold', size: number, max: number) {
    if (this.textWidth(text, family, size) <= max) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.textWidth(text.slice(0, mid) + '…', family, size) <= max) lo = mid;
      else hi = mid - 1;
    }
    return lo ? text.slice(0, lo) + '…' : '';
  }

  /** Up to two lines, word-wrapped, the second ellipsised. */
  private wrap2(text: string, family: 'sans-bold', size: number, max: number): string[] {
    if (this.textWidth(text, family, size) <= max) return [text];
    const words = text.split(/(?<=[\s._/-])/);
    let line = '';
    let i = 0;
    for (; i < words.length; i++) {
      const next = line + words[i];
      if (line && this.textWidth(next, family, size) > max) break;
      line = next;
    }
    if (i >= words.length) return [this.fit(line, family, size, max)];
    return [this.fit(line.trimEnd(), family, size, max), this.fit(words.slice(i).join(''), family, size, max)];
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
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
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
    // At rest only the few strongest contracts are drawn. Pointing at a closed
    // circle, or selecting one, brings in every contract that crosses its rim.
    const selKey = scene.selectedEdge;
    const anyEdgeSel = !!selKey && scene.contracts.some((c) => c.key === selKey);
    const hoverNode = this.hover?.type === 'node' && !this.hover.open ? this.hover.id : null;
    const fv = hoverNode ?? sv;
    const withinMemo = new Map<string, boolean>();
    const within = (id: string): boolean => {
      if (!fv) return false;
      let hit = withinMemo.get(id);
      if (hit == null) {
        let cur: string | null = id;
        while (cur && cur !== fv) cur = tree.nodes.get(cur)?.parent ?? null;
        withinMemo.set(id, (hit = cur === fv));
      }
      return hit;
    };
    const rest = this.restSet(scene);
    const hoverKey = this.hover?.type === 'edge' || this.hover?.type === 'tag' ? this.hover.key : null;
    const focusEdges: { g: Contract; A: Circle; B: Circle; role: 'focus' | 'sel' | 'rest' }[] = [];
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
    // Rest edges underneath, the ones in focus on top.
    const drawn = [...resting, ...focusEdges.slice(0, MAX_EDGES)];
    const inFocus = focusEdges.length > 0 || anyEdgeSel;
    const heaviest = Math.max(1, ...drawn.map((e) => e.g.items.length));
    const tagQueue: { g: Contract; x: number; y: number; isSel: boolean; touches: boolean }[] = [];
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
      const A0 = tree.nodes.get(g.a)!;
      const stroke = isSel ? INK : this.nodeColor(A0, 1);
      let op = role === 'rest' ? (inFocus ? this.policy.restFade : g.cross ? 0.7 : 0.55) : isSel ? 1 : anyEdgeSel ? 0.25 : 0.9;
      if (guess && !isSel) op *= 0.8;
      if (isHover) op = Math.max(op, 0.9);
      // Width follows the log of the number of interactions, relative to the heaviest on screen.
      const sw = 1.2 + 6.8 * (Math.log(n) / Math.log(Math.max(2, heaviest))) + (isHover ? 1 : 0);
      ctx.globalAlpha = op;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = sw;
      ctx.setLineDash(guess ? [0.5, 3 + sw] : g.cross ? [6, 5] : []);
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
      // Letter tags on what's in focus and the edge under the pointer; on the resting overview only if the policy asks.
      const tagged = isSel || isHover || (role === 'focus' ? i - resting.length < MAX_TAGS : this.policy.restTags && !inFocus && i < MAX_TAGS);
      if (tagged && c.gap > 36) {
        // Mid-curve, or the nearest point to it that isn't off screen or under a panel.
        const at = tagPoint(x1, y1, mx, my, x2, y2, tagBox);
        if (at) tagQueue.push({ g, x: at.x, y: at.y, isSel, touches: role === 'focus' });
      }
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
      // Fade in circles that are new in this layout.
      ctx.globalAlpha = anim && !anim.from.has(n.id) ? lt : 1;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = this.nodeColor(n, isOpen ? 0.035 : leaf ? 0.5 : 0.12);
      ctx.fill();
      ctx.lineWidth = sel ? 2 : n.id === hoverId ? 1.6 : 1;
      ctx.strokeStyle = sel || n.id === hoverId ? INK : this.nodeColor(n, isOpen ? 0.35 : 0.65);
      ctx.stroke();
      this.drawnNodes.push({ n, x: s.x, y: s.y, r: s.r, open: isOpen });
    }
    ctx.globalAlpha = 1;
    if (scene.activity?.size) this.pulsing = drawRings(ctx, this.drawnNodes, scene.activity, Date.now());

    // ── labels ──
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const hoverTab = this.hover?.type === 'tab' ? this.hover.id : null;
    for (const d of this.drawnNodes) {
      const { n, x, y, r } = d;
      const big = n.kind === 'repo' || n.kind === 'domain';
      if (d.open) {
        const fam = big ? 'sans-bold' : 'mono';
        const size = big ? 13 : 11;
        const collapse = scene.mode === 'click';
        const name = this.fit(n.name, fam, size, 300);
        const tw = this.textWidth(name, fam, size) + (collapse ? 16 : 0);
        const bh = big ? 22 : 18;
        const bw = tw + 16;
        const bx = x - bw / 2;
        const by = y - r - bh / 2;
        if (by + bh < 0 || by > h || bx + bw < 0 || bx > w) continue;
        ctx.fillStyle = BG;
        ctx.strokeStyle = n.id === hoverTab ? INK : this.nodeColor(n, 0.45);
        ctx.lineWidth = 1;
        roundRect(ctx, bx, by, bw, bh, bh / 2);
        ctx.fill();
        ctx.stroke();
        this.font(big ? 'sans-bold' : 'mono', size);
        ctx.fillStyle = big ? INK : 'rgba(230,227,218,0.72)';
        ctx.fillText(name, x - (collapse ? 8 : 0), by + bh / 2 + 0.5);
        if (collapse) {
          ctx.fillStyle = n.id === hoverTab ? INK : 'rgba(230,227,218,0.45)';
          ctx.fillText('−', x + tw / 2 - 4, by + bh / 2 + 0.5);
        }
        this.drawnTabs.push({ id: n.id, x: bx, y: by, w: bw, h: bh });
      } else if (r > LABEL_MIN_R) {
        // Whole pixel sizes, so the glyph cache is reused from frame to frame while zooming.
        const size = Math.round(Math.max(10, Math.min(big ? 26 : 20, r * (big ? 0.24 : 0.2))));
        const max = r * 1.8;
        const lines = big ? this.wrap2(n.name, 'sans-bold', size, max) : [this.fit(n.name, 'mono', size, max)];
        if (!big && r < LABEL_FULL_R && lines[0] !== n.name) {
          // A small circle with a clipped name ("lin…") says nothing. Try a file without its extension, or
          // the last part of a folder path ("react-email" for "packages/react-email"); else leave it to the tooltip.
          const short = n.kind === 'file' ? n.name.replace(/\.[^.]+$/, '') : n.name.slice(n.name.lastIndexOf('/') + 1);
          if (!short || short === n.name || this.textWidth(short, 'mono', size) > max) continue;
          lines[0] = short;
        }
        const sub = (big && r > 48) || (!big && r > 44) ? this.subtitle(n) : null;
        const subSize = Math.max(10, Math.round(size * 0.5));
        const lh = size * 1.1;
        const total = lines.length * lh + (sub ? subSize * 1.5 : 0);
        let cy = y - total / 2 + lh / 2;
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = INK;
        this.font(big ? 'sans-bold' : 'mono', size);
        for (const line of lines) {
          ctx.fillText(line, x, cy);
          cy += lh;
        }
        if (sub) {
          ctx.globalAlpha = 0.55;
          this.font('mono', subSize);
          ctx.fillText(this.fit(sub, 'mono', subSize, max), x, cy - lh / 2 + subSize * 0.9);
        }
        ctx.globalAlpha = 1;
      }
    }

    // ── edge tags ──
    this.font('mono-medium', 11);
    for (const t of tagQueue) {
      const isHover = t.g.key === hoverKey;
      const label = t.g.inferred === t.g.items.length ? `${t.g.tag}?` : t.g.tag;
      const tw = Math.max(20, this.textWidth(label, 'mono', 11) + 12);
      const r = { x: t.x - tw / 2, y: t.y - 10, w: tw, h: 20 };
      ctx.globalAlpha = t.isSel || !anyEdgeSel ? 1 : 0.3;
      ctx.fillStyle = t.isSel ? INK : BG;
      ctx.strokeStyle = t.isSel || isHover ? INK : 'rgba(230,227,218,0.3)';
      ctx.lineWidth = 1;
      roundRect(ctx, r.x, r.y, r.w, r.h, 10);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = t.isSel ? BG : 'rgba(230,227,218,0.85)';
      ctx.fillText(label, t.x, t.y + 0.5);
      this.drawnTags.push({ ...r, key: t.g.key });
    }
    ctx.globalAlpha = 1;

    // ── agent badges, last so they can keep clear of every link, tag and tab ──
    if (scene.activity?.size) {
      const taken = { edges: this.drawnEdges, rects: [...this.drawnTags, ...this.drawnTabs], free: tagBox, view: { w, h } };
      drawBadges(ctx, this.drawnNodes, scene.activity, (s) => this.textWidth(s, 'mono', 10), taken, this.badgeCache);
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
      c = this.edgeCache = { L: scene.L, vis, contracts: scene.contracts, rest: restEdges(scene.contracts, this.visIds, this.policy), bends: new Map(), obstacles };
    }
    return c;
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
    const x = Math.min(this.pointer.x + 14, this.w - this.tip.offsetWidth - 8);
    const y = this.pointer.y + 18 + this.tip.offsetHeight > this.h ? this.pointer.y - this.tip.offsetHeight - 10 : this.pointer.y + 18;
    this.tip.style.transform = `translate(${x}px, ${y}px)`;
  }

  private describe(hit: Hit): string {
    const scene = this.scene;
    if (!scene) return '';
    if (hit.type === 'edge' || hit.type === 'tag') {
      const c = scene.contracts.find((g) => g.key === hit.key);
      if (!c) return '';
      const A = scene.tree.nodes.get(c.a)?.name;
      const B = scene.tree.nodes.get(c.b)?.name;
      const guessed = !c.inferred ? '' : c.inferred === c.items.length ? ' · inferred' : ` · ${c.inferred} inferred`;
      return `${c.tag} · ${A} ⇄ ${B} · ${c.items.length} interaction${c.items.length === 1 ? '' : 's'}${guessed}`;
    }
    const n = scene.tree.nodes.get(hit.id);
    if (!n) return '';
    if (hit.type === 'tab') return `Close ${n.name}`;
    const sub = this.subtitle(n);
    const kind = KIND[n.kind] ?? n.kind;
    let action = '';
    if (scene.mode === 'click') {
      if (scene.selected !== n.id) action = ' · click for details';
      else if (n.children.length && !hit.open) action = ' · click again to open';
    }
    const marks = scene.activity?.get(n.id);
    const changed = marks ? describeMarks(marks, scene.tree.view) : '';
    return `${n.name} · ${kind}${sub ? ` · ${sub}` : ''}${changed ? ` · ${changed}` : ''}${action}`;
  }
}

const KIND: Partial<Record<TNode['kind'], string>> = { repo: 'repository', folder: 'module', file: 'file', symbol: 'symbol', domain: 'domain', layer: 'layer' };

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

/** Where on a curve to put its tag: the middle if that's in `box`, else the in-box point nearest the middle. */
function tagPoint(x1: number, y1: number, cx: number, cy: number, x2: number, y2: number, box: { x0: number; x1: number; y0: number; y1: number }) {
  const at = (t: number) => {
    const u = 1 - t;
    return { x: u * u * x1 + 2 * u * t * cx + t * t * x2, y: u * u * y1 + 2 * u * t * cy + t * t * y2 };
  };
  const inside = (p: { x: number; y: number }) => p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1;
  for (let step = 0; step <= 7; step++) {
    for (const t of step ? [0.5 - step * 0.05, 0.5 + step * 0.05] : [0.5]) {
      const p = at(t);
      if (inside(p)) return p;
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
