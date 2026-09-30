import json
import os
import subprocess
import wave

import pytest

import wake

PHRASES = {"wake": ["hey lumen"], "cancel": ["stop", "cancel", "never mind"]}


@pytest.mark.parametrize("text,final,armed,expected", [
    ("hey lumen", True, False, ("wake", "hey lumen")),
    ("[unk] hey lumen [unk]", True, False, ("wake", "hey lumen")),
    ("[unk] hey lumen", False, False, ("wake", "hey lumen")),
    ("hey", False, False, None),
    ("hey lumen [unk]", False, False, None),
    ("stop", True, True, ("cancel", "stop")),
    ("[unk] stop", True, True, ("cancel", "stop")),
    ("stop", True, False, None),  # not armed: user may be dictating
    ("stop", False, True, None),  # partials never cancel
    ("[unk] stop [unk]", True, True, None),  # "stopwatch"
    ("cancel [unk]", True, True, None),  # "cancel my subscription"
    ("never mind", True, True, ("cancel", "never mind")),
    ("stopwatch", True, True, None),  # full-vocabulary decode
    ("", True, True, None),
])
def test_match(text, final, armed, expected):
    assert wake.match(text, PHRASES, final, armed) == expected


def test_normalize_and_tokens():
    assert wake.normalize("  Hey, LUMEN! ") == "hey lumen"
    assert wake.tokens("[unk] Hey lumen") == ["[unk]", "hey", "lumen"]


def test_build_grammar_drops_oov_phrases():
    known = {"hey", "stop", "cancel", "never", "mind"}.__contains__
    usable, grammar, oov = wake.build_grammar({"wake": ["hey lumen"], "cancel": ["stop", "never mind"]}, known)
    assert oov == ["lumen"]
    assert usable == {"cancel": ["stop", "never mind"]}
    assert grammar == ["never mind", "stop", "[unk]"]


def test_energy_gate():
    gate = wake.EnergyGate(floor=100, hangover=2, every_n=4)
    assert gate.feed(10) == (False, False)
    assert gate.feed(500) == (True, True)  # speech onset: pre-roll the previous block
    assert gate.feed(600) == (True, False)
    assert gate.feed(10) == (True, False)  # hangover
    assert gate.feed(10) == (True, False)
    fed = [gate.feed(10)[0] for _ in range(8)]
    assert fed == [False, False, False, True, False, False, False, True]


def test_rms():
    import array
    assert wake.rms(b"") == 0.0
    assert wake.rms(array.array("h", [1000, -1000] * 50).tobytes()) == pytest.approx(1000)


def test_drop_oldest_queue():
    q = wake.DropOldestQueue(maxsize=3)
    for i in range(5):
        q.put(i)
    assert q.dropped == 2
    assert [q.get(0.1) for _ in range(3)] == [2, 3, 4]


def test_resolve_model_path(tmp_path):
    assert wake.resolve_model_path(str(tmp_path / "missing")) is None
    (tmp_path / "flat" / "am").mkdir(parents=True)
    assert wake.resolve_model_path(str(tmp_path / "flat")) == str(tmp_path / "flat")
    (tmp_path / "nested" / "vosk-model-small-en-us-0.15" / "am").mkdir(parents=True)
    assert wake.resolve_model_path(str(tmp_path / "nested")).endswith("vosk-model-small-en-us-0.15")
    (tmp_path / "nested" / "other" / "am").mkdir(parents=True)
    assert wake.resolve_model_path(str(tmp_path / "nested")) is None


def test_arming_toggle():
    wake.set_cancel_armed(True)
    assert wake.cancel_armed() and wake.status()["cancel_armed"]
    wake.set_cancel_armed(False)
    assert not wake.cancel_armed()


# ---- recognizer integration with synthesized speech -------------------------

def _tts(path, text):
    ps = (
        "Add-Type -AssemblyName System.Speech;"
        "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        "$f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,"
        "[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono);"
        f"$s.SetOutputToWaveFile('{path}',$f);$s.Speak('{text}');$s.Dispose()"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True, timeout=60, capture_output=True)


@pytest.fixture(scope="module")
def model():
    try:
        return wake._load_model()
    except RuntimeError as e:
        pytest.skip(str(e))


def _hits(model, tmp_path, text, armed):
    from vosk import KaldiRecognizer

    path = str(tmp_path / "s.wav")
    try:
        _tts(path, text)
    except (OSError, subprocess.SubprocessError) as e:
        pytest.skip(f"no speech synthesizer: {e}")
    usable, grammar, _ = wake.build_grammar(PHRASES, lambda w: model.vosk_model_find_word(w) >= 0)
    rec = KaldiRecognizer(model, wake.SAMPLE_RATE, json.dumps(grammar))
    hits = []
    with wave.open(path) as w:
        data = w.readframes(w.getnframes()) + b"\0" * 32000  # trailing silence ends the utterance
    for i in range(0, len(data), wake.BLOCK_SAMPLES * 2):
        if rec.AcceptWaveform(data[i:i + wake.BLOCK_SAMPLES * 2]):
            hit = wake.match(json.loads(rec.Result())["text"], usable, True, armed)
        else:
            hit = wake.match(json.loads(rec.PartialResult())["partial"], usable, False, armed)
        if hit:
            hits.append(hit)
            rec.Reset()
    hit = wake.match(json.loads(rec.FinalResult())["text"], usable, True, armed)
    return hits + ([hit] if hit else [])


@pytest.mark.skipif(os.name != "nt", reason="System.Speech")
def test_spoken_wake_phrase(model, tmp_path):
    assert ("wake", "hey lumen") in _hits(model, tmp_path, "hey lumen", armed=False)


@pytest.mark.skipif(os.name != "nt", reason="System.Speech")
def test_spoken_stopwatch_and_subscription_do_not_cancel(model, tmp_path):
    hits = _hits(model, tmp_path, "I need a stopwatch. Please cancel my subscription.", armed=True)
    assert not [h for h in hits if h[0] == "cancel"]


@pytest.mark.skipif(os.name != "nt", reason="System.Speech")
def test_spoken_stop_cancels_only_when_armed(model, tmp_path):
    assert ("cancel", "stop") in _hits(model, tmp_path, "stop", armed=True)
    assert _hits(model, tmp_path, "stop", armed=False) == []
