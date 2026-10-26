// ─────────────────────────────────────────────────────────────────────────
// Microphone permission page. Opened in a real tab (not the popup) so Chrome
// can show the mic prompt in a stable context — the popup closes the moment
// the prompt steals focus, which is why requesting there reads as "denied".
//
// Once granted, Chrome remembers it for the extension origin, and we also
// persist a flag so the popup never has to ask again.
// ─────────────────────────────────────────────────────────────────────────

const root = document.getElementById('root')!

function render(state: 'asking' | 'granted' | 'blocked') {
  const body =
    state === 'granted'
      ? {
          icon: '✓',
          tint: '#7ee2a8',
          title: 'Microphone enabled',
          text: 'You can close this tab. Claude Clip will record narration on your next capture — you won’t be asked again.',
          btn: 'Close',
        }
      : state === 'blocked'
        ? {
            icon: '🎙️',
            tint: '#e5646a',
            title: 'Microphone is blocked',
            text: 'Click the 🎙️/🔒 icon in the address bar (or Site settings) and set Microphone to Allow for this extension, then click Try again.',
            btn: 'Try again',
          }
        : {
            icon: '🎙️',
            tint: '#d97757',
            title: 'Allow microphone for Claude Clip',
            text: 'Chrome will ask once. Allow it so recordings can include your voice narration. Nothing is uploaded — audio stays on your device.',
            btn: 'Allow microphone',
          }

  root.innerHTML = `
    <div class="wrap">
      <div class="badge" style="color:${body.tint}">${body.icon}</div>
      <h1>${body.title}</h1>
      <p>${body.text}</p>
      <button id="act">${body.btn}</button>
    </div>`

  document.getElementById('act')!.addEventListener('click', () => {
    if (state === 'granted') window.close()
    else void request()
  })
}

async function request() {
  render('asking')
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach((t) => t.stop())
    await chrome.storage.local.set({ micGranted: true, micEnabled: true })
    render('granted')
    setTimeout(() => window.close(), 1500)
  } catch {
    render('blocked')
  }
}

const style = document.createElement('style')
style.textContent = `
  :root{color-scheme:dark}
  body{margin:0;background:#1a1915;color:#f4efe6;font:15px/1.55 -apple-system,Segoe UI,system-ui,sans-serif;
       min-height:100vh;display:grid;place-items:center}
  .wrap{max-width:420px;padding:40px 28px;text-align:center}
  .badge{font-size:44px;margin-bottom:10px}
  h1{font-size:22px;letter-spacing:-.02em;margin:0 0 10px}
  p{color:#b3ab9c;margin:0 0 24px}
  button{font:600 14px/1 inherit;padding:13px 22px;border-radius:11px;border:none;
         background:#d97757;color:#1a0f0a;cursor:pointer}
  button:hover{background:#e5946f}
`
document.head.appendChild(style)

// Prompt immediately on load — in a tab this shows the dialog reliably.
void request()
