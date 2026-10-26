// ─────────────────────────────────────────────────────────────────────────
// Claude Clip MCP server (Mode C — the endgame from PLAN.md §8).
//
// Instead of dragging files into Claude, register this server with Claude Code
// and it resolves a Clip into RESOURCES + TOOLS, so the model pulls the
// high-signal overview first (repro steps, timeline, errors, network summary)
// and fetches heavy detail (full request/response bodies, DOM snapshots, the
// storyboard image) only on demand — just-in-time context, minimal tokens.
//
// Run:  CLAUDE_CLIP_DIR=/path/to/Downloads npm run mcp
// ─────────────────────────────────────────────────────────────────────────

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { allClips, clipsDir, findClip } from './clips.ts'

/** The token-light "read this first" view of a capture. */
function overview(ctx: any) {
  return {
    readme: ctx.readme,
    repro_steps: ctx.repro_steps,
    frames: ctx.frames,
    timeline: ctx.timeline,
    errors: ctx.errors,
    network_summary: ctx.network_summary,
    // DOM trees can be large — surface a preview; full text via get_dom_snapshots.
    dom_snapshots: (ctx.dom_snapshots ?? []).map((d: any) => ({
      t_ms: d.t_ms,
      reason: d.reason,
      url: d.url,
      tree_preview: String(d.tree ?? '').slice(0, 600),
    })),
    redaction: ctx.redaction,
    hint: 'Full network bodies: get_network_detail. Full DOM: get_dom_snapshots. Visual: get_storyboard.',
  }
}

const server = new McpServer({ name: 'claude-clip', version: '0.1.0' })

// ── Resource: each clip's overview, prioritized for the assistant ─────────
server.registerResource(
  'clip',
  new ResourceTemplate('clip://{id}', {
    list: async () => ({
      resources: allClips().map((c) => ({
        uri: `clip://${c.id}`,
        name: c.id,
        description: c.ctx.readme?.observed_symptom ?? 'Claude Clip bug capture',
        mimeType: 'application/json',
      })),
    }),
  }),
  {
    title: 'Claude Clip capture',
    description:
      'Correlated bug capture. Read the overview first; the timeline is causal (caused_by).',
  },
  async (uri, variables) => {
    const c = findClip(String(variables.id))
    const text = c
      ? JSON.stringify(overview(c.ctx), null, 2)
      : `Clip "${variables.id}" not found in ${clipsDir()}`
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text,
          annotations: { audience: ['assistant'], priority: 1 },
        },
      ],
    }
  },
)

// ── Tools ─────────────────────────────────────────────────────────────────

server.registerTool(
  'list_clips',
  {
    title: 'List clips',
    description: 'List captured Claude Clip bug reports available to diagnose.',
    inputSchema: {},
  },
  async () => {
    const clips = allClips()
    if (!clips.length) {
      return {
        content: [
          {
            type: 'text',
            text: `No .clip files found in ${clipsDir()}. Export one from the Claude Clip extension, or set CLAUDE_CLIP_DIR to your Downloads folder.`,
          },
        ],
      }
    }
    const lines = clips.map((c) => {
      const r = c.ctx.readme ?? {}
      return `• ${c.id}\n    symptom: ${r.observed_symptom ?? '—'}\n    suspect: ${r.primary_suspect ?? '—'}`
    })
    return { content: [{ type: 'text', text: lines.join('\n') }] }
  },
)

server.registerTool(
  'get_clip_overview',
  {
    title: 'Get clip overview',
    description:
      'High-signal, token-light view of one clip: readme, repro steps, frames, causal timeline, errors, and network summary. Start here.',
    inputSchema: { id: z.string().describe('Clip id or .clip filename') },
  },
  async ({ id }) => {
    const c = findClip(id)
    if (!c) return notFound(id)
    return { content: [{ type: 'text', text: JSON.stringify(overview(c.ctx), null, 2) }] }
  },
)

server.registerTool(
  'get_network_detail',
  {
    title: 'Get network detail',
    description:
      'Full request/response headers and bodies for one network entry. Pass the net id or detail id from network_summary.',
    inputSchema: {
      id: z.string().describe('Clip id'),
      request_id: z.string().describe('net id or detail id from network_summary'),
    },
  },
  async ({ id, request_id }) => {
    const c = findClip(id)
    if (!c) return notFound(id)
    const details = c.ctx.network_detail ?? {}
    const key =
      details[request_id] ? request_id : details[`${request_id}_detail`] ? `${request_id}_detail` : null
    if (!key) {
      return {
        content: [
          { type: 'text', text: `No detail for "${request_id}". Available: ${Object.keys(details).join(', ') || '(none)'}` },
        ],
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(details[key], null, 2) }] }
  },
)

server.registerTool(
  'get_dom_snapshots',
  {
    title: 'Get DOM snapshots',
    description: 'Full DOM accessibility snapshots captured at error moments for one clip.',
    inputSchema: { id: z.string().describe('Clip id') },
  },
  async ({ id }) => {
    const c = findClip(id)
    if (!c) return notFound(id)
    const snaps = c.ctx.dom_snapshots ?? []
    if (!snaps.length) return { content: [{ type: 'text', text: 'No DOM snapshots captured.' }] }
    return { content: [{ type: 'text', text: JSON.stringify(snaps, null, 2) }] }
  },
)

server.registerTool(
  'get_storyboard',
  {
    title: 'Get storyboard',
    description:
      'The keyframe storyboard image (labeled frames at event boundaries) for one clip — the visual ground truth Claude cannot get from video.',
    inputSchema: { id: z.string().describe('Clip id') },
  },
  async ({ id }) => {
    const c = findClip(id)
    if (!c) return notFound(id)
    if (!c.storyboard) return { content: [{ type: 'text', text: 'No storyboard in this clip.' }] }
    return {
      content: [
        { type: 'image', data: Buffer.from(c.storyboard).toString('base64'), mimeType: 'image/png' },
      ],
    }
  },
)

function notFound(id: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `Clip "${id}" not found in ${clipsDir()}.` }],
  }
}

const transport = new StdioServerTransport()
await server.connect(transport)
// stderr is safe (stdout is the MCP channel).
console.error(`[claude-clip] MCP server ready — clips dir: ${clipsDir()}`)
