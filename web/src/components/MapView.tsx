// The map: a canvas the renderer draws into. This component only creates the
// renderer and hands it each new scene; the camera, animation and pointer
// input live in the renderer so zooming never re-renders React.

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { EDGE_POLICIES, type EdgePreset } from '../render/edges.ts';
import { MapRenderer, type RendererEvents, type Scene } from '../render/renderer.ts';
import type { Circle } from '../graph/layout.ts';

interface Props {
  scene: Scene | null;
  /** The previous layout, when the scene's layout just changed and should animate. */
  from?: Map<string, Circle>;
  /** Filled with the renderer once it exists, for camera moves. */
  renderer: RefObject<MapRenderer | null>;
  /** Pixels floating panels cover on the left and right. */
  panels: { left: number; right: number };
  events: RendererEvents;
}

export function MapView({ scene, from, renderer, panels, events }: Props) {
  const stage = useRef<HTMLDivElement>(null);
  // Handlers change every render; the renderer calls through this ref.
  const on = useRef(events);
  on.current = events;

  useLayoutEffect(() => {
    const r = new MapRenderer(stage.current!, {
      node: (id, open) => on.current.node(id, open),
      tab: (id) => on.current.tab(id),
      edge: (key) => on.current.edge(key),
      empty: () => on.current.empty(),
      visible: (vis) => on.current.visible(vis),
      resize: (w, h) => on.current.resize(w, h),
    });
    renderer.current = r;
    // Reachable from the element for scripted walkthroughs and debugging: document.querySelector('.stage').fiada
    (stage.current as HTMLDivElement & { fiada?: MapRenderer }).fiada = r;
    // ?links=all or ?links=none, to compare against the default without a rebuild.
    const links = new URLSearchParams(window.location.search).get('links');
    if (links && links in EDGE_POLICIES) r.setEdgePolicy(links as EdgePreset);
    return () => {
      r.destroy();
      renderer.current = null;
    };
  }, [renderer]);

  useLayoutEffect(() => {
    renderer.current?.setPanels(panels.left, panels.right);
  }, [renderer, panels.left, panels.right]);

  useEffect(() => {
    if (scene) renderer.current?.setScene(scene, from);
  }, [renderer, scene, from]);

  return <div ref={stage} className="stage" />;
}
