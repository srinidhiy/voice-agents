#
# Copyright (c) 2024–2025, Daily
#
# SPDX-License-Identifier: BSD 2-Clause License
#

"""pipecat-quickstart - Pipecat Voice Agent

This bot uses a cascade pipeline: Speech-to-Text → LLM → Text-to-Speech

Required AI services:
- Deepgram (Speech-to-Text)
- Openai_Responses (LLM)
- Cartesia (Text-to-Speech)

Run the bot using::

    uv run bot.py
"""

import os
import time
from collections import deque

from dotenv import load_dotenv
from fastapi.responses import HTMLResponse, JSONResponse
from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer, VADParams
from pipecat.frames.frames import (
    Frame,
    InterimTranscriptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMRunFrame,
    LLMTextFrame,
    MetricsFrame,
    TranscriptionFrame,
)
from pipecat.metrics.metrics import LLMUsageMetricsData, TTFBMetricsData
from pipecat.processors.frame_processor import FrameDirection
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.runner.run import app, main
from pipecat.runner.types import (
    DailyRunnerArguments,
    RunnerArguments,
    SmallWebRTCRunnerArguments,
)
from pipecat.services.cartesia.tts import CartesiaTTSService, GenerationConfig
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.openai.responses.llm import OpenAIResponsesLLMService
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.transports.daily.transport import DailyParams, DailyTransport
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.turns.user_start import TranscriptionUserTurnStartStrategy, VADUserTurnStartStrategy
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy, TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies

load_dotenv(override=True)

_DEFAULT_SYSTEM = (
    "You are a helpful assistant in a voice conversation. Your responses will be spoken "
    "aloud, so avoid emojis, bullet points, or other formatting that can't be spoken. "
    "Respond to what the user said in a creative, helpful, and brief way."
)

_DEFAULT_VOICE = os.getenv("CARTESIA_VOICE_ID", "e07c00bc-4134-4eae-9ea4-1a55fb45746b")
_DEFAULT_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

# Shared transcript event buffer — replaced on each new session.
_events: deque = deque(maxlen=200)

# Mutable metrics dict for the current in-flight bot turn.
# Reset to a fresh dict on each LLMFullResponseStartFrame so that the previous
# turn's event keeps its own reference while the new turn accumulates cleanly.
_turn_metrics: dict = {}


# ── Transcript capture processors ─────────────────────────────────────────────
#
# TranscriptionFrame is consumed by user_aggregator and never flows past it,
# so user turns must be captured BEFORE the aggregator.
# LLMTextFrame originates from the LLM and flows downstream toward TTS,
# so bot turns must be captured AFTER the LLM.
# Two processors share the same events deque.

class UserTranscriptCapture(FrameProcessor):
    """Captures final STT transcripts (placed between stt and user_aggregator)."""

    def __init__(self, events: deque):
        super().__init__()
        self._events = events

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and not isinstance(frame, InterimTranscriptionFrame):
            self._events.append({"role": "user", "text": frame.text, "ts": time.time()})
        await self.push_frame(frame, direction)


class BotTranscriptCapture(FrameProcessor):
    """Captures LLM text output and LLM-side metrics (placed between llm and tts)."""

    def __init__(self, events: deque):
        super().__init__()
        self._events = events
        self._buf: list[str] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        global _turn_metrics
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMFullResponseStartFrame):
            self._buf = []
            _turn_metrics = {}
        elif isinstance(frame, LLMTextFrame):
            self._buf.append(frame.text)
        elif isinstance(frame, MetricsFrame):
            for m in frame.data:
                if isinstance(m, TTFBMetricsData):
                    _turn_metrics["llm_ttfb"] = round(m.value, 3)
                elif isinstance(m, LLMUsageMetricsData):
                    _turn_metrics["prompt_tokens"] = m.value.prompt_tokens
                    _turn_metrics["completion_tokens"] = m.value.completion_tokens
        elif isinstance(frame, LLMFullResponseEndFrame) and self._buf:
            self._events.append({
                "role": "assistant",
                "text": "".join(self._buf),
                "ts": time.time(),
                "metrics": _turn_metrics,  # reference — TTS and late usage metrics update this dict
            })
            self._buf = []
        await self.push_frame(frame, direction)


class MetricsSink(FrameProcessor):
    """Captures TTS-side MetricsFrame (placed at the end of the pipeline)."""

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        global _turn_metrics
        await super().process_frame(frame, direction)
        if isinstance(frame, MetricsFrame):
            for m in frame.data:
                if isinstance(m, TTFBMetricsData) and "tts" in m.processor.lower():
                    _turn_metrics["tts_ttfb"] = round(m.value, 3)
        await self.push_frame(frame, direction)


# ── FastAPI routes ─────────────────────────────────────────────────────────────

@app.get("/lab", response_class=HTMLResponse, include_in_schema=False)
async def lab_ui():
    html_path = os.path.join(os.path.dirname(__file__), "lab.html")
    with open(html_path) as f:
        return HTMLResponse(content=f.read())


@app.get("/api/events", response_class=JSONResponse, include_in_schema=False)
async def get_events(since: float = 0.0):
    """Return transcript events newer than `since` (Unix timestamp)."""
    return [e for e in _events if e["ts"] > since]


# ── Service builders ───────────────────────────────────────────────────────────

def _build_vad(cfg: dict) -> SileroVADAnalyzer:
    return SileroVADAnalyzer(
        params=VADParams(
            confidence=float(cfg.get("confidence", 0.7)),
            start_secs=float(cfg.get("start_secs", 0.2)),
            stop_secs=float(cfg.get("stop_secs", 0.2)),
            min_volume=float(cfg.get("min_volume", 0.6)),
        )
    )


def _build_strategies(cfg: dict) -> UserTurnStrategies:
    """Build turn strategies.

    vad_strict=True  → VAD-only start (pipecat's TranscriptionUserTurnStartStrategy
                        fallback removed). VAD params fully gate responses.
                        Stop: SpeechTimeoutUserTurnStopStrategy (directly tunable).

    vad_strict=False → Pipecat's default behaviour: VAD fires first, but
                        TranscriptionUserTurnStartStrategy acts as a fallback so
                        the bot responds even if VAD misses quiet speech.
                        Stop: TurnAnalyzerUserTurnStopStrategy (smart ML model).
    """
    strict = bool(cfg.get("vad_strict", False))
    speech_timeout = float(cfg.get("user_speech_timeout", 0.6))

    if strict:
        return UserTurnStrategies(
            start=[VADUserTurnStartStrategy()],
            stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=speech_timeout)],
        )
    else:
        return UserTurnStrategies(
            start=[VADUserTurnStartStrategy(), TranscriptionUserTurnStartStrategy()],
            stop=[TurnAnalyzerUserTurnStopStrategy(turn_analyzer=LocalSmartTurnAnalyzerV3())],
        )


def _build_stt(cfg: dict) -> DeepgramSTTService:
    return DeepgramSTTService(
        api_key=os.getenv("DEEPGRAM_API_KEY"),
        settings=DeepgramSTTService.Settings(
            model=cfg.get("model", "nova-3-general"),
            language=cfg.get("language", "en-US"),
        ),
    )


def _build_tts(cfg: dict) -> CartesiaTTSService:
    speed = float(cfg.get("speed", 1.0))
    volume = float(cfg.get("volume", 1.0))
    emotion = cfg.get("emotion") or None

    gen_cfg = None
    if speed != 1.0 or volume != 1.0 or emotion:
        gen_cfg = GenerationConfig(
            speed=speed if speed != 1.0 else None,
            volume=volume if volume != 1.0 else None,
            emotion=emotion,
        )

    return CartesiaTTSService(
        api_key=os.getenv("CARTESIA_API_KEY"),
        settings=CartesiaTTSService.Settings(
            voice=cfg.get("voice_id") or _DEFAULT_VOICE,
            generation_config=gen_cfg,
        ),
    )


def _build_llm(cfg: dict) -> OpenAIResponsesLLMService:
    temperature = cfg.get("temperature")
    return OpenAIResponsesLLMService(
        api_key=os.getenv("OPENAI_API_KEY"),
        settings=OpenAIResponsesLLMService.Settings(
            model=cfg.get("model") or _DEFAULT_MODEL,
            system_instruction=cfg.get("system_instruction") or _DEFAULT_SYSTEM,
            temperature=float(temperature) if temperature is not None else None,
        ),
    )


# ── Bot logic ──────────────────────────────────────────────────────────────────

async def run_bot(transport: BaseTransport, params: dict | None = None):
    """Main bot logic."""
    global _events
    logger.info("Starting bot")
    params = params or {}

    # Clear the event buffer for this new session.
    _events = deque(maxlen=200)

    stt = _build_stt(params.get("stt", {}))
    tts = _build_tts(params.get("tts", {}))
    llm = _build_llm(params.get("llm", {}))

    vad_cfg = params.get("vad", {})

    context = LLMContext()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=_build_vad(vad_cfg),
            user_turn_strategies=_build_strategies(vad_cfg),
        ),
    )

    pipeline = Pipeline([
        transport.input(),
        stt,
        UserTranscriptCapture(_events),   # before aggregator consumes TranscriptionFrame
        user_aggregator,
        llm,
        BotTranscriptCapture(_events),    # after LLM emits LLMTextFrame/MetricsFrame
        tts,
        transport.output(),
        assistant_aggregator,
        MetricsSink(),                    # catches TTS MetricsFrame after full pipeline
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
    )

    @task.rtvi.event_handler("on_client_ready")
    async def on_client_ready(rtvi):
        context.add_message({"role": "user", "content": "Please introduce yourself."})
        await task.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected")

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected")
        await task.cancel()

    runner = PipelineRunner(handle_sigint=False)
    await runner.run(task)


async def bot(runner_args: RunnerArguments):
    """Main bot entry point."""
    params = runner_args.body if isinstance(runner_args.body, dict) else {}
    if params:
        logger.info(
            f"Lab params — vad={params.get('vad')}, "
            f"llm_model={params.get('llm', {}).get('model')}"
        )

    transport = None

    match runner_args:
        case DailyRunnerArguments():
            transport = DailyTransport(
                runner_args.room_url,
                runner_args.token,
                "Pipecat Bot",
                params=DailyParams(
                    audio_in_enabled=True,
                    audio_out_enabled=True,
                ),
            )
        case SmallWebRTCRunnerArguments():
            webrtc_connection: SmallWebRTCConnection = runner_args.webrtc_connection
            transport = SmallWebRTCTransport(
                webrtc_connection=webrtc_connection,
                params=TransportParams(
                    audio_in_enabled=True,
                    audio_out_enabled=True,
                ),
            )
        case _:
            logger.error(f"Unsupported runner arguments type: {type(runner_args)}")
            return

    await run_bot(transport, params)


if __name__ == "__main__":
    main()
