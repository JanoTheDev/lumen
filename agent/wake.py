"""Offline wake word + voice cancel (Vosk grammar mode). Free, local, no cloud.

The recognizer only knows the configured phrases plus "[unk]", which keeps
CPU low and stops random speech from matching. Wake fires on a final result
containing the phrase as whole words (or a partial that is exactly the
phrase); cancel phrases fire only while main has armed them (an action or
plan is running), never while the user is dictating a query.

Model dir: ~/.ai-overlay/vosk-model/ (vosk-model-small-en-us-0.15), either
directly or as the single nested folder that contains am/.
"""
import json
import logging
import math
import os
import queue
import re
import threading
import time
from array import array
from pathlib import Path

log = logging.getLogger(__name__)

SAMPLE_RATE = 16000
BLOCK_SAMPLES = 4000  # 250 ms
QUEUE_BLOCKS = 20
DEFAULT_ENERGY_FLOOR = 120.0  # int16 RMS; quiet room ~20-80, speech ~500+
HANGOVER_BLOCKS = 6  # keep feeding 1.5 s after the last loud block so finals arrive
GATED_EVERY_N = 8  # while quiet, still feed every Nth block
OVERFLOW_LOG_S = 60.0

_lock = threading.Lock()
_state = {
    "thread": None,
    "stop_event": None,
    "phrase": "",
    "model": None,
    "model_path": None,
    "last_error": None,
    "grammar": [],
    "oov": [],
    "dropped": 0,
}
_armed = threading.Event()


# ---- pure helpers -------------------------------------------------------

UNK = "[unk]"


def normalize(s: str) -> str:
    s = re.sub(r"[^\w\s']", " ", (s or "").lower())
    return " ".join(s.split())


def tokens(text: str) -> list:
    """Recognizer text -> normalized words, keeping "[unk]" markers."""
    out = []
    for t in (text or "").lower().split():
        out.extend([UNK] if t == UNK else normalize(t).split())
    return out


def _find(toks: list, phrase: str, allow_unk_after: bool) -> bool:
    want = phrase.split()
    n = len(want)
    for i in range(len(toks) - n + 1):
        if toks[i:i + n] == want and (allow_unk_after or i + n >= len(toks) or toks[i + n] != UNK):
            return True
    return False


def match(text: str, phrase_map: dict, final: bool, armed: bool):
    """(kind, phrase) for a recognizer result, or None.

    Wake: a final containing the phrase as whole words, or a partial that is
    exactly the phrase (after leading unknown words). Cancel: finals only,
    only while `armed`, and not when unknown speech follows the phrase
    ("stopwatch" decodes as "stop [unk]", "cancel my subscription" as
    "cancel [unk]").
    """
    toks = tokens(text)
    if not toks:
        return None
    for p in phrase_map.get("wake", []):
        if final and _find(toks, p, allow_unk_after=True):
            return "wake", p
        if not final:
            i = 0
            while i < len(toks) and toks[i] == UNK:
                i += 1
            if " ".join(toks[i:]) == p:
                return "wake", p
    if final and armed:
        for p in phrase_map.get("cancel", []):
            if _find(toks, p, allow_unk_after=False):
                return "cancel", p
    return None


def oov_words(phrases, known) -> list:
    """Words `known(word) -> bool` rejects, in first-seen order."""
    out = []
    for p in phrases:
        for w in p.split():
            if w not in out and not known(w):
                out.append(w)
    return out


def build_grammar(phrase_map: dict, known):
    """-> (usable phrase_map, grammar list, oov words). Phrases with an OOV word are dropped."""
    oov = oov_words([p for ps in phrase_map.values() for p in ps], known)
    usable = {k: [p for p in ps if not any(w in oov for w in p.split())] for k, ps in phrase_map.items()}
    usable = {k: ps for k, ps in usable.items() if ps}
    grammar = sorted({p for ps in usable.values() for p in ps})
    return usable, grammar + ["[unk]"], oov


def rms(block: bytes) -> float:
    samples = array("h")
    samples.frombytes(block[: len(block) - len(block) % 2])
    if not samples:
        return 0.0
    return math.sqrt(sum(s * s for s in samples) / len(samples))


class EnergyGate:
    """Decides which audio blocks reach the recognizer."""

    def __init__(self, floor: float = DEFAULT_ENERGY_FLOOR, hangover: int = HANGOVER_BLOCKS,
                 every_n: int = GATED_EVERY_N):
        self.floor = floor
        self.hangover = hangover
        self.every_n = max(1, every_n)
        self._open_left = 0
        self._quiet_count = 0

    def feed(self, level: float) -> tuple:
        """-> (feed this block, also feed the previous block first as pre-roll)."""
        if level >= self.floor:
            pre_roll = self._open_left == 0
            self._open_left = self.hangover
            self._quiet_count = 0
            return True, pre_roll
        if self._open_left > 0:
            self._open_left -= 1
            return True, False
        self._quiet_count += 1
        return self._quiet_count % self.every_n == 0, False


class DropOldestQueue:
    def __init__(self, maxsize: int = QUEUE_BLOCKS):
        self.q: queue.Queue = queue.Queue(maxsize=maxsize)
        self.dropped = 0

    def put(self, item) -> None:
        while True:
            try:
                self.q.put_nowait(item)
                return
            except queue.Full:
                try:
                    self.q.get_nowait()
                    self.dropped += 1
                except queue.Empty:
                    pass

    def get(self, timeout: float):
        return self.q.get(timeout=timeout)


def resolve_model_path(root: str) -> str | None:
    """root itself when it holds am/, else its single subfolder that does (wake-model.ts rule)."""
    if not os.path.isdir(root):
        return None
    if os.path.isdir(os.path.join(root, "am")):
        return root
    nested = [os.path.join(root, d) for d in os.listdir(root) if os.path.isdir(os.path.join(root, d, "am"))]
    return nested[0] if len(nested) == 1 else None


# ---- runtime -------------------------------------------------------------

def _model_dir() -> str:
    return str(Path.home() / ".ai-overlay" / "vosk-model")


def _load_model():
    try:
        from vosk import Model, SetLogLevel
    except Exception as e:
        raise RuntimeError(f"vosk not installed: {e}")
    path = resolve_model_path(_model_dir())
    if path is None:
        raise RuntimeError(
            f"Vosk model not found at {_model_dir()}. Download vosk-model-small-en-us-0.15 from "
            "https://alphacephei.com/vosk/models and extract it to that folder.")
    if _state["model"] is None or _state["model_path"] != path:
        SetLogLevel(-1)
        _state["model"], _state["model_path"] = Model(path), path
    return _state["model"]


def _listen_loop(phrase_map: dict, on_detect, on_error, stop_event: threading.Event, energy_floor: float):
    try:
        import sounddevice as sd
        from vosk import KaldiRecognizer
        model = _load_model()
    except Exception as e:
        _state["last_error"] = str(e)
        log.error("%s", e)
        return

    usable, grammar, oov = build_grammar(phrase_map, lambda w: model.vosk_model_find_word(w) >= 0)
    _state["grammar"], _state["oov"] = grammar, oov
    for word in oov:
        phrase = next((p for ps in phrase_map.values() for p in ps if word in p.split()), "")
        log.warning("phrase %r uses %r, which the speech model does not know; it is ignored", phrase, word)
        if on_error:
            on_error({"reason": "phrase-oov", "word": word, "phrase": phrase})
    if not usable:
        _state["last_error"] = f"no usable phrases (unknown words: {', '.join(oov)})"
        return

    rec = KaldiRecognizer(model, SAMPLE_RATE, json.dumps(grammar))
    audio = DropOldestQueue()
    last_overflow_log = [0.0]

    def _cb(indata, frames, time_info, status):
        if status and status.input_overflow:
            now = time.monotonic()
            if now - last_overflow_log[0] > OVERFLOW_LOG_S:
                last_overflow_log[0] = now
                log.warning("audio input overflow")
        audio.put(bytes(indata))

    gate = EnergyGate(energy_floor)
    prev = None
    try:
        with sd.RawInputStream(samplerate=SAMPLE_RATE, blocksize=BLOCK_SAMPLES, dtype="int16",
                               channels=1, callback=_cb):
            _state["last_error"] = None
            log.info("listening (grammar) — %s", ", ".join(f"{k}={v}" for k, v in usable.items()))
            dropped_logged = 0
            while not stop_event.is_set():
                try:
                    data = audio.get(timeout=0.25)
                except queue.Empty:
                    continue
                if audio.dropped != dropped_logged and time.monotonic() - last_overflow_log[0] > OVERFLOW_LOG_S:
                    last_overflow_log[0] = time.monotonic()
                    log.warning("dropped %d audio blocks (recognizer too slow)", audio.dropped - dropped_logged)
                    dropped_logged = audio.dropped
                _state["dropped"] = audio.dropped
                use, pre_roll = gate.feed(rms(data))
                previous, prev = prev, (data, use)
                if not use:
                    continue
                if pre_roll and previous is not None and not previous[1]:
                    rec.AcceptWaveform(previous[0])  # speech onset may start in the quiet block
                if rec.AcceptWaveform(data):
                    text, final = json.loads(rec.Result()).get("text", ""), True
                else:
                    text, final = json.loads(rec.PartialResult()).get("partial", ""), False
                hit = match(text, usable, final, _armed.is_set())
                if hit:
                    log.info("matched %s=%r in %r", hit[0], hit[1], text)
                    rec.Reset()
                    try:
                        on_detect(*hit)
                    except Exception as e:
                        log.error("on_detect error: %s", e)
    except Exception as e:
        _state["last_error"] = str(e)
        log.error("loop error: %s", e)
    log.info("stopped")


def start(wake_phrase: str = "", cancel_phrases=None, on_detect=None, on_error=None,
          energy_floor: float | None = None):
    phrase_map = {}
    if wake_phrase and normalize(wake_phrase):
        phrase_map["wake"] = [normalize(wake_phrase)]
    cancels = [normalize(p) for p in (cancel_phrases or []) if isinstance(p, str) and normalize(p)]
    if cancels:
        phrase_map["cancel"] = cancels
    if not phrase_map:
        raise ValueError("no phrases provided")
    floor = energy_floor if isinstance(energy_floor, (int, float)) and energy_floor >= 0 else DEFAULT_ENERGY_FLOOR
    with _lock:
        _stop_locked()
        stop_event = threading.Event()
        t = threading.Thread(target=_listen_loop, name="wake",
                             args=(phrase_map, on_detect, on_error, stop_event, float(floor)), daemon=True)
        _state.update(thread=t, stop_event=stop_event, grammar=[], oov=[], dropped=0,
                      phrase=" / ".join(f"{k}:{','.join(v)}" for k, v in phrase_map.items()))
        t.start()


def _stop_locked():
    ev, t = _state["stop_event"], _state["thread"]
    if ev is not None:
        ev.set()
    if t is not None and t is not threading.current_thread():
        t.join(timeout=2)
    _state["thread"] = None
    _state["stop_event"] = None


def stop():
    with _lock:
        _stop_locked()


def set_cancel_armed(armed: bool) -> None:
    (_armed.set if armed else _armed.clear)()


def cancel_armed() -> bool:
    return _armed.is_set()


def status() -> dict:
    t = _state["thread"]
    return {
        "running": t is not None and t.is_alive(),
        "phrase": _state["phrase"],
        "model_dir": _model_dir(),
        "model_exists": resolve_model_path(_model_dir()) is not None,
        "last_error": _state["last_error"],
        "cancel_armed": _armed.is_set(),
        "grammar": list(_state["grammar"]),
        "oov": list(_state["oov"]),
        "dropped": _state["dropped"],
    }
