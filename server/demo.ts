// ─────────────────────────────────────────────────────────────────────────
// Demo/test server for Claude Clip. Serves a hub + 4 JS-driven pages that
// deliberately trigger different failure classes so you can record them and
// verify the capture:
//
//   /good           — WORKING baseline (successful fetch, clean console)
//   /broken-api     — 500 / 404 responses + unhandled promise rejection
//   /js-errors      — uncaught TypeError, dead click, crash-on-click
//   /network-chaos  — DNS failure, CORS block, slow request, JSON parse error
//
// Run:  npm run demo   → http://localhost:4900
// ─────────────────────────────────────────────────────────────────────────

import { createServer, type ServerResponse } from "node:http";

const PORT = Number(process.env.CLAUDE_CLIP_DEMO_PORT || 4100);

function send(
    res: ServerResponse,
    status: number,
    body: string,
    type = "text/html",
    cors = true
) {
    const headers: Record<string, string> = { "Content-Type": type };
    if (cors) headers["Access-Control-Allow-Origin"] = "*";
    res.writeHead(status, headers);
    res.end(body);
}

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{font:16px/1.5 -apple-system,Segoe UI,system-ui,sans-serif;margin:0;background:#0b0b0f;color:#f5f5f7}
  .wrap{max-width:760px;margin:0 auto;padding:40px 24px 80px}
  h1{font-size:26px;letter-spacing:-.02em;margin:0 0 6px}
  .sub{color:#a1a1aa;margin:0 0 28px}
  .card{background:#17171c;border:1px solid #26262c;border-radius:14px;padding:20px;margin:14px 0}
  .row{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}
  button{font:600 14px/1 inherit;padding:11px 16px;border-radius:10px;border:1px solid #333;background:#22222a;color:#f5f5f7;cursor:pointer;transition:.15s}
  button:hover{background:#2c2c36}
  button.primary{background:#d97757;color:#1a0f0a;border-color:transparent}
  button.danger{background:#3a1d1d;border-color:#5a2a2a;color:#ff8a80}
  #status{padding:12px 14px;border-radius:10px;margin-top:14px;font-size:14px;display:none}
  #status.show{display:block}
  #status.ok{background:#12261a;border:1px solid #1f5133;color:#7ee2a8}
  #status.err{background:#2a1414;border:1px solid #5a2a2a;color:#ff8a80}
  ul{margin:12px 0 0;padding-left:18px}
  a{color:#d97757}
  nav{margin-bottom:24px;font-size:14px}
  nav a{margin-right:14px}
  .pill{display:inline-block;font-size:12px;padding:3px 9px;border-radius:999px;margin-left:8px}
  .pill.good{background:#12261a;color:#7ee2a8}
  .pill.bad{background:#2a1414;color:#ff8a80}
  code{background:#000;padding:2px 6px;border-radius:5px;color:#ffb340;font-size:13px}
</style></head>
<body><div class="wrap">
<nav><a href="/">← Test hub</a><a href="/good">Working</a><a href="/broken-api">Broken API</a><a href="/js-errors">JS errors</a><a href="/network-chaos">Network chaos</a></nav>
${body}
</div></body></html>`;

// ── pages ──────────────────────────────────────────────────────────────────

const hub = shell(
    "Claude Clip · Test Hub",
    `<h1>Claude Clip — test pages</h1>
  <p class="sub">Start recording in the extension, open a page, click the buttons, then stop &amp; export. Each page triggers a different capture class.</p>
  <div class="card"><h2 style="margin:0 0 6px;font-size:18px">Working <span class="pill good">clean</span></h2>
    <p style="color:#a1a1aa;margin:0 0 10px">Successful API call, tidy console, no errors. The baseline.</p><a href="/good">Open /good →</a></div>
  <div class="card"><h2 style="margin:0 0 6px;font-size:18px">Broken API <span class="pill bad">500 / 404</span></h2>
    <p style="color:#a1a1aa;margin:0 0 10px">Server errors, a 404, <code>console.error</code>, and an unhandled promise rejection.</p><a href="/broken-api">Open /broken-api →</a></div>
  <div class="card"><h2 style="margin:0 0 6px;font-size:18px">JS errors <span class="pill bad">exceptions</span></h2>
    <p style="color:#a1a1aa;margin:0 0 10px">Uncaught <code>TypeError</code> on load, a dead click (broken handler), and a crash-on-click.</p><a href="/js-errors">Open /js-errors →</a></div>
  <div class="card"><h2 style="margin:0 0 6px;font-size:18px">Network chaos <span class="pill bad">DNS · CORS · parse</span></h2>
    <p style="color:#a1a1aa;margin:0 0 10px">DNS failure, a CORS block, a slow request, and a JSON parse error.</p><a href="/network-chaos">Open /network-chaos →</a></div>`
);

const good = shell(
    "Working page",
    `<h1>Working page ✓</h1><p class="sub">Everything succeeds. Console stays clean.</p>
  <div class="card"><div class="row">
    <button class="primary" id="load">Load products</button>
    <button id="refresh">Refresh</button>
  </div><div id="status"></div><ul id="list"></ul></div>
  <script>
    const s=(m,ok=true)=>{const e=document.getElementById('status');e.textContent=m;e.className='show '+(ok?'ok':'err')};
    async function load(){
      console.info('[good] fetching products…');
      const r=await fetch('/api/ok');
      const d=await r.json();
      console.log('[good] loaded', d.products.length, 'products', d);
      document.getElementById('list').innerHTML=d.products.map(p=>'<li>'+p.name+' — $'+p.price+'</li>').join('');
      s('Loaded '+d.products.length+' products ('+r.status+')');
    }
    document.getElementById('load').onclick=load;
    document.getElementById('refresh').onclick=load;
    load();
  </script>`
);

const brokenApi = shell(
    "Broken API",
    `<h1>Broken API ✗</h1><p class="sub">Server-side failures the app doesn't handle well.</p>
  <div class="card"><div class="row">
    <button class="primary" id="pay">Pay $59.98</button>
    <button id="load">Load account (404)</button>
  </div><div id="status"></div></div>
  <script>
    const s=(m,ok=false)=>{const e=document.getElementById('status');e.textContent=m;e.className='show '+(ok?'ok':'err')};
    document.getElementById('pay').onclick=async()=>{
      console.info('[pay] submitting payment…');
      try{
        const r=await fetch('/api/fail',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cartId:'c_88',amount:5998})});
        const d=await r.json();
        if(!r.ok){console.error('[pay] payment failed', r.status, d); s('Payment failed: '+d.error+' ('+r.status+')');}
      }catch(e){console.error('[pay] network error', e); s('Network error');}
    };
    document.getElementById('load').onclick=async()=>{
      const r=await fetch('/api/notfound');
      console.warn('[account] GET /api/notfound →', r.status);
      s('Account endpoint returned '+r.status, false);
    };
    // Unhandled promise rejection — surfaces via Runtime.exceptionThrown
    Promise.reject(new Error('Unhandled: payment token missing from session'));
  </script>`
);

const jsErrors = shell(
    "JS errors",
    `<h1>JS errors ✗</h1><p class="sub">Runtime exceptions and broken click handlers.</p>
  <div class="card"><div class="row">
    <button id="dead">Add to cart (dead click)</button>
    <button class="danger" id="crash">Checkout (crashes)</button>
    <button id="rage">Apply coupon (does nothing)</button>
  </div><div id="status"></div></div>
  <script>
    const s=(m,ok=false)=>{const e=document.getElementById('status');e.textContent=m;e.className='show '+(ok?'ok':'err')};
    console.warn('[init] using deprecated cartService v1');
    // Dead click: handler runs but produces no visible effect (silent bug)
    document.getElementById('dead').onclick=()=>{ const _unused = 1+1; /* nothing happens */ };
    // Crash: uncaught TypeError on click
    document.getElementById('crash').onclick=()=>{
      console.info('[checkout] starting…');
      const cart=null;
      s('Checking out '+cart.items.length+' items'); // TypeError: Cannot read properties of null
    };
    document.getElementById('rage').onclick=()=>{ /* no-op — click me repeatedly */ };
    // Uncaught TypeError on load
    (function(){ const config=window.__APP_CONFIG__; console.log('[boot] region:', config.region); })();
  </script>`
);

const networkChaos = shell(
    "Network chaos",
    `<h1>Network chaos ✗</h1><p class="sub">DNS failure, CORS block, slow request, and a JSON parse error.</p>
  <div class="card"><div class="row">
    <button class="primary" id="all">Run all requests</button>
    <button id="dns">DNS failure</button>
    <button id="cors">CORS block</button>
    <button id="slow">Slow (3s)</button>
    <button id="parse">Bad JSON</button>
  </div><div id="status"></div></div>
  <script>
    const PORT=${PORT};
    const s=(m,ok=false)=>{const e=document.getElementById('status');e.textContent=m;e.className='show '+(ok?'ok':'err')};
    async function dns(){ try{ await fetch('https://no-such-host-'+Date.now()+'.invalid/api'); }catch(e){ console.error('[dns] request failed', e.message); s('DNS/network failure (see console + network tab)'); } }
    async function cors(){ try{ const r=await fetch('http://127.0.0.1:'+PORT+'/api/data-nocors'); await r.json(); }catch(e){ console.error('[cors] blocked by CORS', e.message); s('CORS blocked (cross-origin 127.0.0.1, no ACAO header)'); } }
    async function slow(){ console.info('[slow] waiting…'); const r=await fetch('/api/slow'); const d=await r.json(); console.log('[slow] done', d); s('Slow request finished ('+r.status+')', true); }
    async function parse(){ const r=await fetch('/api/malformed'); const t=await r.text(); try{ JSON.parse(t); }catch(e){ console.error('[parse] invalid JSON from /api/malformed:', e.message, '· body:', t); s('JSON parse error (malformed API response)'); } }
    document.getElementById('dns').onclick=dns;
    document.getElementById('cors').onclick=cors;
    document.getElementById('slow').onclick=slow;
    document.getElementById('parse').onclick=parse;
    document.getElementById('all').onclick=()=>{ dns(); cors(); slow(); parse(); };
  </script>`
);

// ── server ──────────────────────────────────────────────────────────────────

const products = [
    { name: "Ford Racing Bronco Roof Light", price: 425 },
    { name: "Cusco GR Yaris Mud Flaps", price: 189 },
    { name: "Recaro Performance Seat Set", price: 2499 },
];

const server = createServer((req, res) => {
    const path = (req.url || "/").split("?")[0];
    switch (path) {
        case "/":
            return send(res, 200, hub);
        case "/good":
            return send(res, 200, good);
        case "/broken-api":
            return send(res, 200, brokenApi);
        case "/js-errors":
            return send(res, 200, jsErrors);
        case "/network-chaos":
            return send(res, 200, networkChaos);

        // APIs
        case "/api/ok":
            return send(
                res,
                200,
                JSON.stringify({ ok: true, products }),
                "application/json"
            );
        case "/api/fail":
            return send(
                res,
                500,
                JSON.stringify({
                    error: "Internal Server Error: NullPointerException in cartService.charge()",
                }),
                "application/json"
            );
        case "/api/notfound":
            return send(
                res,
                404,
                JSON.stringify({ error: "account not found" }),
                "application/json"
            );
        case "/api/slow":
            return void setTimeout(
                () =>
                    send(
                        res,
                        200,
                        JSON.stringify({ ok: true, waitedMs: 3000 }),
                        "application/json"
                    ),
                3000
            );
        case "/api/malformed":
            return send(
                res,
                200,
                '{ "ok": true, products: [oops not valid json',
                "application/json"
            );
        case "/api/data-nocors":
            // Deliberately NO Access-Control-Allow-Origin → cross-origin fetch blocked.
            return send(
                res,
                200,
                JSON.stringify({
                    secret: "you should not see this cross-origin",
                }),
                "application/json",
                false
            );

        default:
            return send(
                res,
                404,
                shell(
                    "Not found",
                    '<h1>404</h1><p><a href="/">Back to hub</a></p>'
                )
            );
    }
});

server.listen(PORT, () => {
    console.error(`[claude-clip] demo pages on http://localhost:${PORT}`);
});
