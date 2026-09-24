/**
 * Where a kind may live (D008). A feature's documents sit in one of three layer directories and the layer is
 * the rule: `edge/` speaks the world, `domain/` holds the business rules, `data/` translates and carries the
 * effects. A connection is a channel shared across features, so it stays at the tree's root.
 */
import { type Kind, type Layer, layerOf } from './model.js';
import { stem } from './paths.js';
import type { Refusal } from './registry.js';

interface Home {
  layers?: Layer[];
  dir?: string;
  why: string;
}

/** The one place placement lives: the layers (or top-level directory) each kind is at home in, and why. */
export const HOME: Partial<Record<Kind, Home>> = {
  trigger: { layers: ['edge'], why: "a trigger is a way in: it speaks the world's vocabulary" },
  policy: { layers: ['edge'], why: 'a policy gates a way in: it reads the request the way a trigger does' },
  graph: { layers: ['domain', 'data'], why: 'a graph is business rules (domain/) or a translation (data/)' },
  binding: { layers: ['data'], why: "a binding says how a domain port is met, which is the data layer's job" },
  store: { layers: ['data'], why: "a store says how records are kept, which is the data layer's job" },
  port: { layers: ['domain'], why: 'a domain port is the contract the business offers' },
  invariant: { layers: ['domain'], why: 'an invariant is a rule of the business, over its ports and shapes' },
  shape: { layers: ['edge', 'domain'], why: "a shape is the world's (edge/) or ours (domain/)" },
  resolvers: {
    layers: ['edge'],
    why: "a resolvers document names what is read from the request, which is the world's vocabulary",
  },
  connection: { dir: 'connections', why: 'a connection is a channel to an external system, shared across features' },
  scenario: { dir: 'scenarios', why: 'a scenario is a recorded run' },
};

/** A document as it is about to be placed: its kind, its tree path, the feature it sits in, and its content. */
export interface Placement {
  kind: Kind;
  file: string;
  feature: string | undefined;
  doc: unknown;
}

/** The refusal for a document that is not where its kind lives, or null when it is home. */
export function misplaced(placement: Placement): Refusal | null {
  const home = HOME[placement.kind];
  if (!home) return null;
  if (home.dir) return misplacedDir(placement, home.dir, home.why);
  const layers = home.layers ?? [];
  if (!placement.feature) return outsideFeature(placement, layers, home.why);
  const layer = layerOf(`@${placement.file}`);
  const disagrees = placement.kind === 'shape' && layer ? shapeDisagrees(placement, layer) : null;
  if (disagrees) return disagrees;
  if (layer && layers.includes(layer)) return null;
  return wrongLayer(placement, layers, layer, home.why);
}

/** A kind with a top-level directory outside it: moved into that directory, the one place it may live. */
function misplacedDir(placement: Placement, dir: string, why: string): Refusal | null {
  const { kind, file } = placement;
  if (file.split('/')[0] === dir) return null;
  const to = `${dir}/${stem(file)}.${kind}.json`;
  return {
    code: 'D008',
    file,
    message: `a ${kind} lives under ${dir}/`,
    hint: `${why}; move it to ${to}`,
    fixes: [{ file, move: to }],
  };
}

/** A layered kind outside any feature: no fix, since which feature it belongs to is the author's to say. */
function outsideFeature(placement: Placement, layers: Layer[], why: string): Refusal {
  const { kind, file } = placement;
  return {
    code: 'D008',
    file,
    message: `a ${kind} lives inside a feature, under ${layers.map(layer => `${layer}/`).join(' or ')}`,
    hint: `${why}; move it to features/<name>/${layers[0]}/`,
  };
}

/**
 * A shape says its layer twice -- in `layer` and in the directory. They must agree, and the directory wins: in
 * `edge/` or `domain/` the fix is `layer` set to the directory's, since a move would leave every reference to
 * the shape behind; in `data/`, where no shape lives, the one fix is the move to the layer it declares.
 */
function shapeDisagrees(placement: Placement, layer: Layer): Refusal | null {
  const { file, feature } = placement;
  const written = (placement.doc as { layer?: string }).layer;
  const declared = written === 'edge' ? 'edge' : 'domain';
  if (declared === layer) return null;
  const refusal = {
    code: 'D008',
    file,
    at: 'layer',
    message: `shape declares layer '${written}' but sits in ${layer}/`,
  };
  if (layer === 'data') {
    const to = `features/${feature}/${declared}/${stem(file)}.shape.json`;
    return { ...refusal, hint: `a shape lives in edge/ or domain/; move it to ${to}`, fixes: [{ file, move: to }] };
  }
  const setTo = layer === 'edge' ? 'edge' : 'core';
  return {
    ...refusal,
    hint: `a shape's layer is where it lives; move it to features/${feature}/${declared}/, or set "layer": "${setTo}"`,
    fixes: [{ file, at: 'layer', set: setTo }],
  };
}

/** A document in no layer, or in one its kind may not live in: moved home when the kind has one layer, else the author's call. */
function wrongLayer(placement: Placement, layers: Layer[], layer: Layer | undefined, why: string): Refusal {
  const { kind, file, feature } = placement;
  const to = `features/${feature}/${layers[0]}/${stem(file)}.${kind}.json`;
  return {
    code: 'D008',
    file,
    message: layer
      ? `a ${kind} may not live in the ${layer} layer`
      : `a ${kind} must sit in a layer directory (${layers.join(', ')})`,
    hint: `${why}; move it to ${to}`,
    ...(layers.length === 1 ? { fixes: [{ file, move: to }] } : {}),
  };
}
