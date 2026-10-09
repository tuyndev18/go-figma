// 2D affine transforms in Figma's row layout: [[a, c, tx], [b, d, ty]]
//   x' = a*x + c*y + tx
//   y' = b*x + d*y + ty
export type Matrix = [[number, number, number], [number, number, number]];

export interface Point {
  x: number;
  y: number;
}

export function apply(m: Matrix, p: Point): Point {
  return {
    x: m[0][0] * p.x + m[0][1] * p.y + m[0][2],
    y: m[1][0] * p.x + m[1][1] * p.y + m[1][2],
  };
}

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    [
      m[0][0] * n[0][0] + m[0][1] * n[1][0],
      m[0][0] * n[0][1] + m[0][1] * n[1][1],
      m[0][0] * n[0][2] + m[0][1] * n[1][2] + m[0][2],
    ],
    [
      m[1][0] * n[0][0] + m[1][1] * n[1][0],
      m[1][0] * n[0][1] + m[1][1] * n[1][1],
      m[1][0] * n[0][2] + m[1][1] * n[1][2] + m[1][2],
    ],
  ];
}

export function invert(m: Matrix): Matrix {
  const [[a, c, tx], [b, d, ty]] = m;
  const det = a * d - b * c;
  if (det === 0) throw new Error("Matrix is not invertible");
  return [
    [d / det, -c / det, (c * ty - d * tx) / det],
    [-b / det, a / det, (b * tx - a * ty) / det],
  ];
}

/** Uniform scale of a transform (instances resized with Figma's scale tool, K). */
export function scaleOf(m: Matrix): number {
  return Math.hypot(m[0][0], m[1][0]);
}

/** The same transform with its scale removed: rotation and translation only. */
export function withoutScale(m: Matrix): Matrix {
  const sx = Math.hypot(m[0][0], m[1][0]) || 1;
  const sy = Math.hypot(m[0][1], m[1][1]) || 1;
  return [
    [m[0][0] / sx, m[0][1] / sy, m[0][2]],
    [m[1][0] / sx, m[1][1] / sy, m[1][2]],
  ];
}

/**
 * Place a `width × height` node (in its own local units), whose local→container
 * transform is `m`, as a CSS box: unrotated top-left plus a clockwise rotation
 * around its center. CSS rotates around the center by default, so matching
 * centers is enough. Any scale in `m` is applied to the size.
 */
export function boxFromTransform(
  m: Matrix,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number; rotation: number; flip?: boolean } {
  const center = apply(m, { x: width / 2, y: height / 2 });
  // A mirrored transform is R(θ)·diag(-s, s): undo the mirror before reading
  // the angle, otherwise a horizontal flip reads as a 180° rotation.
  const flip = m[0][0] * m[1][1] - m[0][1] * m[1][0] < 0;
  let rotation = (Math.atan2(flip ? -m[1][0] : m[1][0], flip ? -m[0][0] : m[0][0]) * 180) / Math.PI;
  if (rotation < -179.99) rotation += 360; // -0 from the negation lands on -180°
  const scale = scaleOf(m);
  return {
    x: center.x - (width * scale) / 2,
    y: center.y - (height * scale) / 2,
    width: width * scale,
    height: height * scale,
    rotation: Math.abs(rotation) < 0.01 ? 0 : rotation,
    ...(flip ? { flip } : {}),
  };
}
