/**
 * Shared helpers for the `brand-assets` suite.
 *
 * The work package ships two SVG assets plus a component that re-draws the same glyph,
 * so the tests need to reason about SVG *content*, not only about strings. No SVG parser
 * (and no new dependency) is added: `parseSvg` below is a small, strict reader for the
 * subset of XML an icon may use - it validates well-formedness (single root, balanced
 * tags, quoted attributes, no stray markup) and returns a tree, which is all the
 * assertions need.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root: `tests/brand-assets/support/svg.ts` -> `../../..`. */
export const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export function read(relativePath: string): string {
  return readFileSync(join(PROJECT_ROOT, relativePath), 'utf8');
}

export function exists(relativePath: string): boolean {
  return existsSync(join(PROJECT_ROOT, relativePath));
}

export interface SvgNode {
  name: string;
  attrs: Record<string, string>;
  children: SvgNode[];
  text: string;
}

const TAG_RE = /<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'<])*?)(\/?)>/g;
const ATTR_RE = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttributes(raw: string, elementName: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let remainder = raw;
  let match: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((match = ATTR_RE.exec(raw)) !== null) {
    const name = match[1] ?? '';
    const value = match[3] ?? match[4] ?? '';
    if (Object.prototype.hasOwnProperty.call(attrs, name)) {
      throw new Error(`<${elementName}> declares the attribute "${name}" twice`);
    }
    attrs[name] = value;
    remainder = remainder.replace(match[0], ' ');
  }
  if (remainder.trim().length > 0) {
    // An unquoted or valueless attribute, or a stray character in the tag.
    throw new Error(`<${elementName}> has a malformed attribute list: "${remainder.trim()}"`);
  }
  return attrs;
}

/**
 * Parse an SVG document and return its single root element.
 *
 * Throws (rather than returning a null-ish result) so a malformed asset fails the test
 * that called it with a readable message.
 */
export function parseSvg(source: string): SvgNode {
  const cleaned = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '');

  const documentRoot: SvgNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: SvgNode[] = [documentRoot];
  let cursor = 0;
  let match: RegExpExecArray | null;

  const appendText = (raw: string): void => {
    if (raw.includes('<')) throw new Error(`stray "<" at offset ${cursor} (unbalanced markup)`);
    const current = stack[stack.length - 1];
    if (raw.trim().length === 0) return;
    if (current === undefined || current === documentRoot) {
      throw new Error(`text outside the root element: ${JSON.stringify(raw.trim())}`);
    }
    current.text += raw;
  };

  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(cleaned)) !== null) {
    appendText(cleaned.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    const closing = match[1] === '/';
    const name = match[2] ?? '';
    const selfClosing = match[4] === '/';

    if (closing) {
      if (selfClosing) throw new Error(`<${match[0]}> is malformed (closing tag with "/")`);
      const open = stack.pop();
      if (open === undefined || open.name !== name) {
        throw new Error(`</${name}> does not close <${open === undefined ? 'nothing' : open.name}>`);
      }
      continue;
    }

    const node: SvgNode = { name, attrs: parseAttributes(match[3] ?? '', name), children: [], text: '' };
    const parent = stack[stack.length - 1];
    if (parent === undefined) throw new Error(`unexpected </${name}>`);
    parent.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  appendText(cleaned.slice(cursor));

  if (stack.length !== 1) {
    throw new Error(`unclosed <${stack[stack.length - 1]?.name ?? '?'}> element`);
  }
  if (documentRoot.children.length !== 1) {
    throw new Error(`expected exactly one root element, found ${documentRoot.children.length}`);
  }
  const root = documentRoot.children[0];
  if (root === undefined) throw new Error('empty document');
  return root;
}

/** Depth-first walk over an element and all of its descendants. */
export function walk(node: SvgNode, visit: (node: SvgNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/** Every element in the document (root included) flattened. */
export function flatten(root: SvgNode): SvgNode[] {
  const all: SvgNode[] = [];
  walk(root, (node) => all.push(node));
  return all;
}

/** All elements with the given tag name. */
export function elementsNamed(root: SvgNode, name: string): SvgNode[] {
  return flatten(root).filter((node) => node.name === name);
}

const COLOUR_ATTRS = ['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color', 'color'] as const;

/**
 * Every colour value the document actually paints with: the paint attributes plus the
 * `fill`/`stroke`/`color` declarations of any `style` attribute.
 */
export function paintColours(root: SvgNode): string[] {
  const colours: string[] = [];
  for (const node of flatten(root)) {
    for (const attr of COLOUR_ATTRS) {
      const value = node.attrs[attr];
      if (value !== undefined) colours.push(value.trim());
    }
    const style = node.attrs['style'];
    if (style !== undefined) {
      for (const declaration of style.split(';')) {
        const [property, value] = declaration.split(':');
        if (property === undefined || value === undefined) continue;
        if ((COLOUR_ATTRS as readonly string[]).includes(property.trim())) {
          colours.push(value.trim());
        }
      }
    }
  }
  return colours;
}

/** Normalised hex literals used anywhere in the document's paint attributes. */
export function hexColours(root: SvgNode): string[] {
  return paintColours(root)
    .filter((value) => /^#/.test(value))
    .map((value) => value.toLowerCase());
}

/** `number [unit]` values such as `width="32"` or `viewBox="0 0 32 32"`. */
export function viewBoxOf(root: SvgNode): number[] {
  const raw = root.attrs['viewBox'];
  if (raw === undefined) throw new Error('<svg> has no viewBox');
  const parts = raw.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    throw new Error(`<svg viewBox="${raw}"> is not four numbers`);
  }
  return parts;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Read an *absolute* `M/L/H/V/Z` path into its vertices.
 *
 * The brand glyph is a flat polygon on purpose, so anything else (relative commands,
 * curves, arcs) is rejected instead of silently mis-measured - a future asset that
 * needs those commands must extend this helper and its tests.
 */
export function pathVertices(d: string): { points: Point[]; closed: boolean } {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
  const points: Point[] = [];
  let closed = false;
  let command = '';
  let index = 0;
  let current: Point = { x: 0, y: 0 };

  const nextNumber = (): number => {
    const token = tokens[index];
    index += 1;
    if (token === undefined) throw new Error(`path data "${d}" ends in the middle of a command`);
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error(`path data "${d}" contains "${token}"`);
    return value;
  };

  while (index < tokens.length) {
    const token = tokens[index] ?? '';
    if (/^[A-Za-z]$/.test(token)) {
      command = token;
      index += 1;
      if (command === 'Z') {
        closed = true;
        continue;
      }
    }
    switch (command) {
      case 'M':
        current = { x: nextNumber(), y: nextNumber() };
        points.push(current);
        command = 'L';
        break;
      case 'L':
        current = { x: nextNumber(), y: nextNumber() };
        points.push(current);
        break;
      case 'H':
        current = { x: nextNumber(), y: current.y };
        points.push(current);
        break;
      case 'V':
        current = { x: current.x, y: nextNumber() };
        points.push(current);
        break;
      default:
        throw new Error(`unsupported path command "${command}" in "${d}" (expected absolute M/L/H/V/Z)`);
    }
  }
  return { points, closed };
}

/** Axis-aligned bounds of a vertex list. */
export function boundsOf(points: readonly Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (points.length === 0) throw new Error('no points');
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

/** x of the point on segment a->b at height y (linear interpolation). */
export function xAtY(a: Point, b: Point, y: number): number {
  if (a.y === b.y) throw new Error('segment is horizontal; x at y is undefined');
  return a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y);
}

/** How many device pixels one user unit becomes when the icon is drawn at `size` px. */
export function deviceScale(iconSize: number, renderedSize: number): number {
  return renderedSize / iconSize;
}

/** Even-odd point-in-polygon test (the fill rule `<path>` uses without `fill-rule`). */
export function pointInPolygon(x: number, y: number, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a === undefined || b === undefined) continue;
    const straddles = a.y > y !== b.y > y;
    if (straddles && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export interface Raster {
  /** `size` rows of `size` booleans, true where the glyph is painted. */
  pixels: boolean[][];
  /** Number of painted pixels. */
  glyphPixels: number;
}

/**
 * Rasterise the glyph polygons at `size` px by sampling each pixel centre, using the
 * even-odd rule across all polygons together.
 *
 * This is a crude box-sampled raster (no antialiasing, no sub-pixel coverage), which is
 * exactly what makes it useful for the 16px question: if a feature disappears at the
 * pixel centres it is gone for a real 16px render too.
 */
export function rasterize(polygons: readonly (readonly Point[])[], size: number, sourceUnits: number): Raster {
  const pixels: boolean[][] = [];
  let glyphPixels = 0;
  const step = sourceUnits / size;
  for (let row = 0; row < size; row += 1) {
    const line: boolean[] = [];
    const y = (row + 0.5) * step;
    for (let column = 0; column < size; column += 1) {
      const x = (column + 0.5) * step;
      const painted = polygons.some((polygon) => pointInPolygon(x, y, polygon));
      line.push(painted);
      if (painted) glyphPixels += 1;
    }
    pixels.push(line);
  }
  return { pixels, glyphPixels };
}

export interface AvatarTokens {
  brand: string;
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  text: string;
  muted: string;
}

/**
 * The `:root` (dark) palette of `src/app/globals.css`, keyed by token name.
 *
 * Only the first `:root` block is read: the `.light` block redefines the same custom
 * properties, and the brand assets deliberately target the dark values.
 */
export function readTokenPalette(css: string): Partial<Record<keyof AvatarTokens, string>> {
  const rootBlock = /:root\s*\{([\s\S]*?)\}/.exec(css);
  if (rootBlock === null) throw new Error('globals.css has no :root token block');
  const body = rootBlock[1] ?? '';
  const palette: Partial<Record<keyof AvatarTokens, string>> = {};
  const declaration = /--([\w-]+)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(body)) !== null) {
    const name = match[1] ?? '';
    const value = (match[2] ?? '').trim();
    if (name === 'bg') palette.bg = value;
    else if (name === 'brand') palette.brand = value;
    else if (name === 'surface') palette.surface = value;
    else if (name === 'surface-2') palette.surface2 = value;
    else if (name === 'border') palette.border = value;
    else if (name === 'text') palette.text = value;
    else if (name === 'text-muted') palette.muted = value;
  }
  return palette;
}
