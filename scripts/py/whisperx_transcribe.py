#!/usr/bin/env python3
"""
Transcription with word-level timestamps.
Usage: python3 whisperx_transcribe.py <audio16k.wav> <out.json>
Writes: {"language":..., "duration":..., "words":[{"word","start","end","line"}, ...]}

Primary engine: faster-whisper (CTranslate2) — fast on CPU, native word timestamps.
Fallback engine: whisperx (if installed & importable).
Requires: python3 -m pip install --user faster-whisper   (or whisperx)
"""
import json
import sys


def _cuda():
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


def faster_whisper_path(wav, out, language=None, prompt=None):
    from faster_whisper import WhisperModel
    device = "cuda" if _cuda() else "cpu"
    compute = "float16" if device == "cuda" else "int8"
    model = WhisperModel("base", device=device, compute_type=compute)
    kw = dict(
        language=language,       # None = auto-detect
        word_timestamps=True,
        vad_filter=True,          # drop non-speech stretches first
        beam_size=5,
        condition_on_previous_text=False,  # reduces hallucination on tone/noise
    )
    if prompt:
        kw["initial_prompt"] = prompt   # custom vocabulary / spelling bias
    segments, info = model.transcribe(wav, **kw)
    words = []
    line = 0
    duration = 0.0
    for seg in segments:
        duration = max(duration, seg.end or 0.0)
        for w in (seg.words or []):
            text = (w.word or "").strip()
            if not text or w.start is None:
                continue
            words.append({
                "word": text,
                "start": round(float(w.start), 3),
                "end": round(float(w.end), 3),
                "line": line,
            })
        line += 1
    if not duration:
        duration = float(getattr(info, "duration", 0.0) or 0.0)
    words.sort(key=lambda w: w["start"])
    with open(out, "w") as f:
        json.dump({"language": info.language or "en", "duration": round(duration, 3), "words": words}, f)
    sys.stderr.write(f"OK faster-whisper {len(words)} words\n")


def whisperx_path(wav, out, language=None, prompt=None):
    import whisperx
    device = "cuda" if _cuda() else "cpu"
    compute = "float16" if device == "cuda" else "int8"
    model = whisperx.load_model("base", device, compute_type=compute)
    audio = whisperx.load_audio(wav)
    kw = {"batch_size": 16}
    if language:
        kw["language"] = language
    if prompt:
        kw["initial_prompt"] = prompt
    result = model.transcribe(audio, **kw)
    words = []
    duration = 0.0
    for i, seg in enumerate(result["segments"]):
        start, end = float(seg["start"]), float(seg["end"])
        duration = max(duration, end)
        toks = (seg.get("text") or "").strip().split()
        if not toks:
            continue
        span = max(0.2, end - start) / len(toks)
        for j, tok in enumerate(toks):
            words.append({
                "word": tok,
                "start": round(start + j * span, 3),
                "end": round(start + (j + 1) * span, 3),
                "line": i,
            })
    words.sort(key=lambda w: w["start"])
    with open(out, "w") as f:
        json.dump({"language": result.get("language", "en"), "duration": round(duration, 3), "words": words}, f)
    sys.stderr.write(f"OK whisperx {len(words)} words\n")


def main():
    wav, out = sys.argv[1], sys.argv[2]
    language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
    prompt = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None
    errors = []
    try:
        faster_whisper_path(wav, out, language, prompt)
        return
    except Exception as e:
        errors.append(f"faster-whisper: {e}")
    try:
        whisperx_path(wav, out, language, prompt)
        return
    except Exception as e:
        errors.append(f"whisperx: {e}")
    sys.stderr.write("TRANSCRIBE_FAILED " + " | ".join(errors) + "\n")
    sys.exit(4)


if __name__ == "__main__":
    main()
