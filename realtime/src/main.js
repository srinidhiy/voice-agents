import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
import { tool } from '@openai/agents';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const transcriptEl = document.getElementById('transcript');
const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const speakingBar  = document.getElementById('speaking-bar');
const statsBar     = document.getElementById('stats-bar');
const toggleBtn    = document.getElementById('toggle-btn');
const errorMsg     = document.getElementById('error-msg');

// ── Agent definition ──────────────────────────────────────────────────────────
async function searchGoogle({ query }) {
  try {
    const response = await fetch(`/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) {
      const { error } = await response.json();
      throw new Error(error);
    }
    return await response.json();
  } catch (error) {
    console.error('Error searching Google:', error);
    return "I couldn't find any information on that topic.";
  }
}

const searchGoogleTool = tool({
  name: 'search_google',
  description:
    'Search the web (Google via Serper). Call this whenever the user asks for current events, facts you are unsure about, news, prices, or anything that needs up-to-date information. Prefer this over guessing.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The query to search for' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  execute: searchGoogle,
});


const agent = new RealtimeAgent({
  name: 'Assistant',
  instructions:
    'You are a helpful assistant. Be concise and friendly. For time-sensitive facts, current events, or anything you are not certain about, call search_google before answering. After you get results, summarize them briefly for the user.',
  voice: 'marin',
  tools: [searchGoogleTool],
});

// ── Session state ─────────────────────────────────────────────────────────────
let session = null;

const agentBuffers  = new Map(); // itemId → { text, latency } — accumulated until audio_stopped
const pendingTools  = [];        // { row, startTime } — sequential tool calls
let userPlaceholder = null;      // { turn, bubble } reserved on speech_started

// ── Metrics state ─────────────────────────────────────────────────────────────
let speechStoppedAt = null;  // timestamp when user finished speaking
let totalTurns      = 0;
const allLatencies  = [];

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

function addTurn(role, text, latencyMs = null) {
  const turn = document.createElement('div');
  turn.className = `turn ${role}`;

  const labelRow = document.createElement('div');
  labelRow.className = 'turn-label-row';

  const label = document.createElement('div');
  label.className = 'turn-label';
  label.textContent = role === 'user' ? 'You' : 'Agent';
  labelRow.appendChild(label);

  if (latencyMs !== null) {
    const badge = document.createElement('div');
    badge.className = 'latency-badge';
    badge.textContent = `↓ ${(latencyMs / 1000).toFixed(2)}s`;
    labelRow.appendChild(badge);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;

  turn.appendChild(labelRow);
  turn.appendChild(bubble);
  transcriptEl.appendChild(turn);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return { turn, bubble };
}

function addToolRow(name, query) {
  const row = document.createElement('div');
  row.className = 'tool-row';
  row.innerHTML = `<span class="tool-name">${name}</span>`
    + (query ? `<span class="tool-query">"${query}"</span>` : '')
    + `<span class="tool-duration">…</span>`;
  transcriptEl.appendChild(row);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return row;
}

function updateStats() {
  if (allLatencies.length === 0) { statsBar.innerHTML = ''; return; }
  const avg  = Math.round(allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length);
  const last = allLatencies[allLatencies.length - 1];
  statsBar.innerHTML =
    `<span class="stat-item">${totalTurns} turn${totalTurns !== 1 ? 's' : ''}</span>`
    + `<span class="stat-item">avg <span class="stat-value">${avg}ms</span></span>`
    + `<span class="stat-item">last <span class="stat-value">${last}ms</span></span>`;
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
    const data = await res.json();
    // API returns { value, expires_at, session, ... }; older docs used client_secret.value
    const ephemeralKey = data.client_secret?.value ?? data.value;
    if (!ephemeralKey) {
      throw new Error('Invalid session response: no ephemeral key');
    }

    session = new RealtimeSession(agent, {
      transport: 'webrtc',  // browser WebRTC — handles mic + audio output automatically
      model: 'gpt-realtime',
      config: {
        toolChoice: 'auto',
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

    // accumulate agent transcript — render only when the full response is done
    session.transport.on('audio_transcript_delta', ({ itemId, delta }) => {
      if (!agentBuffers.has(itemId)) {
        let latency = null;
        if (speechStoppedAt !== null) {
          latency = Date.now() - speechStoppedAt;
          speechStoppedAt = null;
          totalTurns++;
          allLatencies.push(latency);
          updateStats();
        }
        agentBuffers.set(itemId, { text: delta, latency });
      } else {
        agentBuffers.get(itemId).text += delta;
      }
    });

    // ── Session-level events ────────────────────────────────────────────────
    session.on('audio_start', () => setSpeaking('agent'));

    session.on('audio_stopped', () => {
      setSpeaking(null);
      for (const { text, latency } of agentBuffers.values()) {
        if (text) addTurn('agent', text, latency);
      }
      agentBuffers.clear();
    });

    session.on('audio_interrupted', () => {
      setSpeaking(null);
      for (const { text, latency } of agentBuffers.values()) {
        if (text) addTurn('agent', text, latency);
      }
      agentBuffers.clear();
    });

    // raw transport events — user speech + user transcript
    session.on('transport_event', (event) => {
      if (event.type === 'input_audio_buffer.speech_started') {
        // reserve the user bubble slot now so it always appears above the agent response
        userPlaceholder = addTurn('user', '…');
        userPlaceholder.bubble.style.opacity = '0.4';
        setSpeaking('user');
      }
      if (event.type === 'input_audio_buffer.speech_stopped') {
        speechStoppedAt = Date.now();
        setSpeaking(null);
      }
      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const text = event.transcript?.trim();
        if (userPlaceholder) {
          if (text) {
            userPlaceholder.bubble.textContent = text;
            userPlaceholder.bubble.style.opacity = '';
          } else {
            userPlaceholder.turn.remove();
          }
          userPlaceholder = null;
        } else if (text) {
          addTurn('user', text);
        }
      }
    });

    session.on('error', ({ error }) => {
      showError(String(error));
    });

    session.on('agent_tool_start', (_ctx, _agent, toolDef, details) => {
      let query = '';
      try { query = JSON.parse(details.toolCall.arguments || '{}').query ?? ''; } catch {}
      const row = addToolRow(toolDef.name, query);
      pendingTools.push({ row, startTime: Date.now() });
    });

    session.on('agent_tool_end', () => {
      const entry = pendingTools.shift();
      if (entry) {
        const ms = Date.now() - entry.startTime;
        const dur = entry.row.querySelector('.tool-duration');
        if (dur) dur.textContent = `${(ms / 1000).toFixed(2)}s`;
      }
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
  agentBuffers.clear();
  pendingTools.length = 0;
  if (userPlaceholder) { userPlaceholder.turn.remove(); userPlaceholder = null; }
  speechStoppedAt = null;
  totalTurns      = 0;
  allLatencies.length = 0;
  statsBar.innerHTML = '';
  setStatus('', 'Disconnected');
  setSpeaking(null);
  toggleBtn.textContent = 'Start';
  toggleBtn.className = '';
  toggleBtn.disabled = false;
}
