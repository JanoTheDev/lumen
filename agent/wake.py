import os
import json
import queue
import threading
from pathlib import Path

# Vosk-based offline wake-word detector. Free, local, no cloud.
# Model dir: ~/.ai-overlay/vosk-model/ (vosk-model-small-en-us-0.15 recommended)

_state = {
    'thread': None,
    'stop_event': None,
    'phrase': '',
    'on_detect': None,
    'model': None,
    'last_error': None,
}

def _model_dir() -> str:
    return str(Path.home() / '.ai-overlay' / 'vosk-model')

def _normalize(s: str) -> str:
    s = s.lower().strip()
    return ' '.join(ch for ch in s.split() if ch)

def _load_model():
    if _state['model'] is not None:
        return _state['model']
    try:
        from vosk import Model
    except Exception as e:
        raise RuntimeError(f'vosk not installed: {e}')

    path = _model_dir()
    if not os.path.isdir(path):
        raise RuntimeError(f'Vosk model not found at {path}. Download vosk-model-small-en-us-0.15 from https://alphacephei.com/vosk/models and extract to that folder.')

    _state['model'] = Model(path)
    return _state['model']

def _listen_loop(phrase_map: dict, on_detect, stop_event: threading.Event):
    # phrase_map: { 'wake': ['hey lumen'], 'cancel': ['stop', 'cancel', ...] }
    try:
        import sounddevice as sd
        from vosk import KaldiRecognizer
    except Exception as e:
        _state['last_error'] = f'import error: {e}'
        return

    try:
        model = _load_model()
    except Exception as e:
        _state['last_error'] = str(e)
        print(f'[wake] {e}', flush=True)
        return

    sample_rate = 16000
    rec = KaldiRecognizer(model, sample_rate)
    q: queue.Queue = queue.Queue()

    def _cb(indata, frames, time_info, status):
        if status:
            pass
        q.put(bytes(indata))

    # Build { kind -> [normalized phrases] }
    norm_map = {kind: [_normalize(p) for p in phrases if p.strip()]
                for kind, phrases in phrase_map.items()}
    norm_map = {k: v for k, v in norm_map.items() if v}
    if not norm_map:
        print('[listener] no phrases to match, exiting', flush=True)
        return

    try:
        with sd.RawInputStream(samplerate=sample_rate, blocksize=8000, dtype='int16',
                               channels=1, callback=_cb):
            summary = ', '.join(f'{k}={v}' for k, v in norm_map.items())
            print(f'[listener] listening (offline) — {summary}', flush=True)
            while not stop_event.is_set():
                try:
                    data = q.get(timeout=0.25)
                except queue.Empty:
                    continue
                is_final = rec.AcceptWaveform(data)
                if is_final:
                    text = json.loads(rec.Result()).get('text', '')
                else:
                    text = json.loads(rec.PartialResult()).get('partial', '')
                if not text:
                    continue
                norm_text = _normalize(text)
                matched_kind = None
                matched_phrase = None
                for kind, phrases in norm_map.items():
                    for p in phrases:
                        if p and p in norm_text:
                            matched_kind = kind
                            matched_phrase = p
                            break
                    if matched_kind:
                        break
                if matched_kind:
                    print(f'[listener] matched {matched_kind}="{matched_phrase}" in: "{text}"', flush=True)
                    rec = KaldiRecognizer(model, sample_rate)
                    try: on_detect(matched_kind, matched_phrase)
                    except Exception as e: print(f'[listener] on_detect error: {e}', flush=True)
    except Exception as e:
        _state['last_error'] = str(e)
        print(f'[listener] loop error: {e}', flush=True)
    print('[listener] stopped', flush=True)

def start(wake_phrase: str = '', cancel_phrases=None, on_detect=None):
    stop()
    cancel_phrases = cancel_phrases or []
    phrase_map = {}
    if wake_phrase and wake_phrase.strip():
        phrase_map['wake'] = [wake_phrase.strip()]
    if cancel_phrases:
        phrase_map['cancel'] = [p.strip() for p in cancel_phrases if p and p.strip()]
    if not phrase_map:
        raise ValueError('no phrases provided')
    stop_event = threading.Event()
    t = threading.Thread(target=_listen_loop, args=(phrase_map, on_detect, stop_event), daemon=True)
    _state['thread'] = t
    _state['stop_event'] = stop_event
    _state['phrase'] = ' / '.join(f'{k}:{",".join(v)}' for k, v in phrase_map.items())
    _state['on_detect'] = on_detect
    t.start()

def stop():
    ev = _state['stop_event']
    if ev is not None:
        ev.set()
    _state['thread'] = None
    _state['stop_event'] = None

def status() -> dict:
    return {
        'running': _state['thread'] is not None and _state['thread'].is_alive(),
        'phrase': _state['phrase'],
        'model_dir': _model_dir(),
        'model_exists': os.path.isdir(_model_dir()),
        'last_error': _state['last_error'],
    }
