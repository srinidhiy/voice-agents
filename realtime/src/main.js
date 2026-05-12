import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const transcriptEl = document.getElementById('transcript');
const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const speakingBar  = document.getElementById('speaking-bar');
const toggleBtn    = document.getElementById('toggle-btn');
const errorMsg     = document.getElementById('error-msg');

// ── Agent definition ──────────────────────────────────────────────────────────
const agent = new RealtimeAgent({
  name: 'Assistant',
  instructions: 'You are a helpful assistant. Be concise and friendly.',
  voice: 'verse',
});

// ── Session state ─────────────────────────────────────────────────────────────
let session = null;

// tracks streaming agent bubbles keyed by itemId
const agentBubbles = new Map(); // itemId → { turn, bubble, text }

// ── UI helpers ────────────────────────────────────────────────────────────────
function setStatus(state, label) {
  statusDot.className = state;
  statusText.textContent = label;
}

function showError(msg) {
  errorMsg.textContent = msg;
}

function clearError() {
  errorMsg.textContent = '';
}

function setSpeaking(who) {
  const wave = `<div class="wave">
    <span></span><span></span><span></span><span></span><span></span>
  </div>`;
  if (who === 'user') {
    speakingBar.innerHTML = `${wave}<span>You are speaking…</span>`;
  } else if (who === 'agent') {
    speakingBar.innerHTML = `${wave}<span>Agent is speaking…</span>`;
  } else {
    speakingBar.innerHTML = '';
  }
}

function addTurn(role, text) {
  const turn = document.createElement('div');
  turn.className = `turn ${role}`;

  const label = document.createElement('div');
  label.className = 'turn-label';
  label.textContent = role === 'user' ? 'You' : 'Agent';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;

  turn.appendChild(label);
  turn.appendChild(bubble);
  transcriptEl.appendChild(turn);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return { turn, bubble };
}

// ── Session management ────────────────────────────────────────────────────────
toggleBtn.addEventListener('click', () => {
  if (session) {
    stopSession();
  } else {
    startSession();
  }
});

async function startSession() {
  clearError();
  toggleBtn.disabled = true;
  setStatus('connecting', 'Connecting…');

  try {
    // fetch ephemeral key from our Express server
    const res = await fetch('/session');
    if (!res.ok) {
      const { error } = await res.json();
      throw new Error(error || 'Failed to get session token');
    }
    const { client_secret } = await res.json();
    const ephemeralKey = client_secret.value;

    session = new RealtimeSession(agent, {
      transport: 'webrtc',  // browser WebRTC — handles mic + audio output automatically
      model: 'gpt-realtime',
      config: {
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: { type: 'server_vad' },
      },
    });

    // ── Transport-level events ──────────────────────────────────────────────
    session.transport.on('connection_change', (status) => {
      if (status === 'connected') {
        setStatus('connected', 'Connected');
        toggleBtn.textContent = 'Stop';
        toggleBtn.className = 'stop';
        toggleBtn.disabled = false;
      } else if (status === 'connecting') {
        setStatus('connecting', 'Connecting…');
      } else {
        stopSession();
      }
    });

    // streaming agent transcript delta — one event per itemId
    session.transport.on('audio_transcript_delta', ({ itemId, delta }) => {
      if (!agentBubbles.has(itemId)) {
        const els = addTurn('agent', delta);
        els.bubble.classList.add('partial');
        agentBubbles.set(itemId, { ...els, text: delta });
      } else {
        const entry = agentBubbles.get(itemId);
        entry.text += delta;
        entry.bubble.textContent = entry.text;
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
      }
    });

    // ── Session-level events ────────────────────────────────────────────────
    session.on('audio_start', () => setSpeaking('agent'));

    session.on('audio_stopped', () => {
      setSpeaking(null);
      // mark all in-progress agent bubbles as finalized
      for (const entry of agentBubbles.values()) {
        entry.bubble.classList.remove('partial');
      }
      agentBubbles.clear();
    });

    session.on('audio_interrupted', () => {
      setSpeaking(null);
      for (const entry of agentBubbles.values()) {
        entry.bubble.classList.remove('partial');
      }
      agentBubbles.clear();
    });

    // raw transport events — user speech + user transcript
    session.on('transport_event', (event) => {
      if (event.type === 'input_audio_buffer.speech_started') {
        setSpeaking('user');
      }
      if (event.type === 'input_audio_buffer.speech_stopped') {
        setSpeaking(null);
      }
      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const text = event.transcript?.trim();
        if (text) addTurn('user', text);
      }
    });

    session.on('error', ({ error }) => {
      showError(String(error));
    });

    await session.connect({ apiKey: ephemeralKey });

  } catch (err) {
    showError(err.message);
    stopSession();
  }
}

function stopSession() {
  if (session) {
    session.close();
    session = null;
  }
  agentBubbles.clear();
  setStatus('', 'Disconnected');
  setSpeaking(null);
  toggleBtn.textContent = 'Start';
  toggleBtn.className = '';
  toggleBtn.disabled = false;
}
