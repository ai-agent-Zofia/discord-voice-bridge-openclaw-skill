#!/usr/bin/env python3
import json
import os
import sys

from faster_whisper import WhisperModel

MODEL_NAME = os.getenv("STT_MODEL", "tiny.en")
COMPUTE_TYPE = os.getenv("STT_COMPUTE", "int8")

model = WhisperModel(MODEL_NAME, device="cpu", compute_type=COMPUTE_TYPE)

for raw in sys.stdin:
    line = raw.strip()
    if not line:
        continue

    req_id = None
    try:
        payload = json.loads(line)
        req_id = payload.get("id")
        wav_path = payload.get("path")
        if not wav_path:
            raise ValueError("Missing 'path'")

        segments, _info = model.transcribe(
            wav_path,
            language="en",
            beam_size=1,
            vad_filter=True,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
        out = {"id": req_id, "text": text}
    except Exception as e:
        out = {"id": req_id, "error": str(e)}

    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
