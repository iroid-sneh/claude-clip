// ─────────────────────────────────────────────────────────────────────────
// Floating toolbar markup + styles, rendered inside a Shadow DOM so no page
// CSS can touch it (and vice-versa). Apple-grade glass pill, Excalidraw-grade
// tool set. Icons are inline SVG (no external assets — CSP-safe).
// ─────────────────────────────────────────────────────────────────────────

const ICONS: Record<string, string> = {
  cursor: '<path d="M4 3l7 16 2-6 6-2z"/>',
  pen: '<path d="M4 20l3-1 10-10-2-2L5 17z"/><path d="M15 5l2 2"/>',
  arrow: '<path d="M5 19L19 5"/><path d="M11 5h8v8"/>',
  rectangle: '<rect x="4" y="6" width="16" height="12" rx="1.5"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6"/>',
  highlighter: '<path d="M4 18h6"/><path d="M6 15l7-9 4 3-7 9H6z"/>',
  text: '<path d="M5 6h14"/><path d="M12 6v13"/><path d="M9 19h6"/>',
  eraser: '<path d="M6 18h9"/><path d="M8 16l-3-3 7-7 4 4-6 6z"/>',
  undo: '<path d="M9 7L4 12l5 5"/><path d="M4 12h10a5 5 0 010 10h-3"/>',
  clear: '<path d="M6 7h12"/><path d="M9 7V5h6v2"/><path d="M8 7l1 12h6l1-12"/>',
}

function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`
}

function toolBtn(tool: string, title: string): string {
  return `<button class="cc-tool" data-act="tool" data-val="${tool}" title="${title}">${icon(tool)}</button>`
}

export function toolbarMarkup(colors: string[], widths: number[]): string {
  const tools = [
    toolBtn('cursor', 'Interact with page'),
    toolBtn('pen', 'Pen'),
    toolBtn('arrow', 'Arrow'),
    toolBtn('rectangle', 'Rectangle'),
    toolBtn('ellipse', 'Ellipse'),
    toolBtn('highlighter', 'Highlighter'),
    toolBtn('text', 'Add a text note'),
  ].join('')

  const swatches = colors
    .map(
      (c) =>
        `<button class="cc-swatch" data-act="color" data-val="${c}" style="--sw:${c}" title="${c}"></button>`,
    )
    .join('')

  const widthBtns = widths
    .map(
      (w, i) =>
        `<button class="cc-width" data-act="width" data-val="${w}" title="Stroke ${i + 1}"><span style="height:${w}px"></span></button>`,
    )
    .join('')

  return `
    <div class="cc-toolbar" data-claude-clip="toolbar">
      <div class="cc-grip"></div>
      <div class="cc-group">${tools}</div>
      <div class="cc-sep"></div>
      <div class="cc-group cc-colors">${swatches}</div>
      <div class="cc-sep"></div>
      <div class="cc-group cc-widths">${widthBtns}</div>
      <div class="cc-sep"></div>
      <div class="cc-group">
        <button class="cc-tool" data-act="undo" title="Undo">${icon('undo')}</button>
        <button class="cc-tool" data-act="clear" title="Clear all">${icon('clear')}</button>
      </div>
    </div>`
}

export const TOOLBAR_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .cc-toolbar {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 5px;
    padding: 6px 8px;
    /* Never wider than the viewport — on narrow / mobile screens the toolbar
       wraps to multiple rows instead of overflowing off-screen. */
    max-width: calc(100vw - 12px);
    box-sizing: border-box;
    border-radius: 16px;
    background: rgba(24, 24, 28, 0.82);
    backdrop-filter: blur(20px) saturate(1.4);
    -webkit-backdrop-filter: blur(20px) saturate(1.4);
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255,255,255,0.06);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    animation: cc-rise 0.32s cubic-bezier(0.22, 1, 0.36, 1);
  }
  @keyframes cc-rise {
    from { opacity: 0; transform: translate(-50%, 12px); }
    to   { opacity: 1; transform: translate(-50%, 0); }
  }
  .cc-grip { width: 3px; height: 20px; border-radius: 3px; background: rgba(255,255,255,0.12); margin: 0 2px 0 0; }
  .cc-group { display: flex; align-items: center; gap: 3px; }
  .cc-sep { width: 1px; height: 22px; background: rgba(255,255,255,0.1); margin: 0 3px; }

  .cc-tool {
    width: 34px; height: 34px;
    display: grid; place-items: center;
    border: none; border-radius: 10px;
    background: transparent; color: #e6e6ea;
    cursor: pointer;
    transition: background 0.16s ease, transform 0.12s ease, color 0.16s ease;
  }
  .cc-tool svg { width: 19px; height: 19px; }
  .cc-tool:hover { background: rgba(255,255,255,0.09); }
  .cc-tool:active { transform: scale(0.92); }
  .cc-tool.active {
    background: #d97757; color: #1a0f0a;
    box-shadow: 0 2px 8px rgba(217,119,87,0.4);
  }

  .cc-swatch {
    width: 22px; height: 22px; margin: 0 1px;
    border-radius: 50%; cursor: pointer;
    background: var(--sw);
    border: 2px solid transparent;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.15);
    transition: transform 0.12s ease, border-color 0.16s ease;
  }
  .cc-swatch:hover { transform: scale(1.15); }
  .cc-swatch.active { border-color: #fff; transform: scale(1.12); }

  .cc-width {
    width: 30px; height: 34px;
    display: grid; place-items: center;
    border: none; border-radius: 9px; background: transparent;
    cursor: pointer; transition: background 0.16s ease;
  }
  .cc-width span { display: block; width: 18px; border-radius: 9px; background: #e6e6ea; }
  .cc-width:hover { background: rgba(255,255,255,0.09); }
  .cc-width.active { background: rgba(255,255,255,0.14); }
  .cc-width.active span { background: #fff; }

  /* Narrow / mobile viewports: shrink to fit and drop dividers so the tools
     wrap into a tidy 2-row pill instead of running off-screen. */
  @media (max-width: 480px) {
    .cc-toolbar { gap: 3px; padding: 6px; }
    .cc-grip, .cc-sep { display: none; }
    .cc-tool { width: 30px; height: 30px; border-radius: 8px; }
    .cc-tool svg { width: 17px; height: 17px; }
    .cc-swatch { width: 19px; height: 19px; }
    .cc-width { width: 26px; height: 30px; }
    .cc-group { gap: 2px; }
  }
`
