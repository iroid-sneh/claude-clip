// ─────────────────────────────────────────────────────────────────────────
// Hand-drawn rendering (the Excalidraw feel):
//   • pen / highlighter  → perfect-freehand pressure outline, filled path
//   • rectangle/ellipse  → roughjs sketchy primitives
//   • arrow              → roughjs line + composed arrowhead
// Retained-mode: the controller re-renders all annotations + the live stroke
// every frame. A stable per-annotation seed keeps the sketch from jittering.
// ─────────────────────────────────────────────────────────────────────────

import rough from 'roughjs'
import type { RoughCanvas } from 'roughjs/bin/canvas'
import { getStroke } from 'perfect-freehand'
import type { Annotation, ToolKind } from '@/shared/types'

export interface StrokeStyle {
  tool: ToolKind
  color: string
  strokeWidth: number
}

function seedFrom(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return Math.abs(h) % 2 ** 31
}

/** Convert perfect-freehand outline points to a filled Path2D. */
function freehandPath(points: number[]): Path2D {
  const stroke = getStroke(pairs(points), {
    size: 8,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: true,
  })
  const path = new Path2D()
  if (!stroke.length) return path
  path.moveTo(stroke[0][0], stroke[0][1])
  for (let i = 1; i < stroke.length; i++) {
    const [x, y] = stroke[i]
    path.lineTo(x, y)
  }
  path.closePath()
  return path
}

function pairs(flat: number[]): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < flat.length - 1; i += 2) out.push([flat[i], flat[i + 1]])
  return out
}

export function renderAnnotation(
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  a: Annotation,
): void {
  drawShape(ctx, rc, a.type, a.points, {
    tool: a.type,
    color: a.color,
    strokeWidth: a.strokeWidth,
  }, seedFrom(a.id))
}

export function renderLive(
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  style: StrokeStyle,
  points: number[],
  seed: number,
): void {
  drawShape(ctx, rc, style.tool, points, style, seed)
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  tool: ToolKind,
  points: number[],
  style: StrokeStyle,
  seed: number,
): void {
  if (points.length < 2) return

  if (tool === 'pen' || tool === 'eraser') {
    ctx.save()
    ctx.fillStyle = style.color
    ctx.fill(freehandPath(points))
    ctx.restore()
    return
  }

  if (tool === 'highlighter') {
    ctx.save()
    ctx.globalAlpha = 0.35
    ctx.globalCompositeOperation = 'multiply'
    ctx.strokeStyle = style.color
    ctx.lineWidth = style.strokeWidth * 6
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(points[0], points[1])
    for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1])
    ctx.stroke()
    ctx.restore()
    return
  }

  // Shapes use the first and last point as bounding corners / endpoints.
  const x0 = points[0]
  const y0 = points[1]
  const x1 = points[points.length - 2]
  const y1 = points[points.length - 1]
  const opts = {
    stroke: style.color,
    strokeWidth: style.strokeWidth,
    roughness: 1.4,
    bowing: 1.2,
    seed,
  }

  if (tool === 'rectangle') {
    rc.rectangle(x0, y0, x1 - x0, y1 - y0, opts)
  } else if (tool === 'ellipse') {
    rc.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0), Math.abs(y1 - y0), opts)
  } else if (tool === 'arrow') {
    rc.line(x0, y0, x1, y1, opts)
    drawArrowhead(rc, x0, y0, x1, y1, opts)
  }
}

function drawArrowhead(
  rc: RoughCanvas,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  opts: object,
): void {
  const angle = Math.atan2(y1 - y0, x1 - x0)
  const len = 16
  const spread = Math.PI / 7
  rc.line(x1, y1, x1 - len * Math.cos(angle - spread), y1 - len * Math.sin(angle - spread), opts)
  rc.line(x1, y1, x1 - len * Math.cos(angle + spread), y1 - len * Math.sin(angle + spread), opts)
}

export function makeRough(canvas: HTMLCanvasElement): RoughCanvas {
  return rough.canvas(canvas)
}
