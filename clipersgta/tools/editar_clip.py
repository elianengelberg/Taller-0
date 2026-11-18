#!/usr/bin/env python3
"""Editor automático de clips para Clipersgta._

Toma un clip en bruto y lo deja listo para TikTok / YouTube Shorts:
  - recorte (inicio/fin)
  - formato vertical 1080x1920 con fondo desenfocado
  - gancho bilingüe arriba los primeros segundos (EN grande, ES chico)
  - subtítulos automáticos (Whisper) grandes y centrados
  - crédito del creador abajo todo el video
  - voz IA opcional (edge-tts) mezclada sobre el audio original
  - exporta MP4 H.264 + AAC, 30 fps

Ejemplo:
  python3 tools/editar_clip.py media/raw/clip.mp4 --start 12 --end 38 \
      --hook-en "THIS NPC HAD NO CHILL" --hook-es "Este NPC no tuvo piedad" \
      --credit "@creador" --voz "Mirá lo que hizo este NPC" --voz-idioma es

Requisitos: ffmpeg, pip install faster-whisper edge-tts
"""
import argparse
import asyncio
import os
import subprocess
import sys
import tempfile

W, H = 1080, 1920
FONT = "Inter"
VOICES = {"es": "es-AR-TomasNeural", "en": "en-US-GuyNeural"}


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"Error en: {' '.join(cmd)}\n{r.stderr[-2000:]}")
    return r.stdout


def ts(t):
    t = max(t, 0)
    h, m = int(t // 3600), int(t % 3600 // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def esc(text):
    return text.replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", " ")


def duration(path):
    return float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                      "-of", "csv=p=0", path]).strip())


def transcribe(audio_src, model_size, lang):
    from faster_whisper import WhisperModel
    import numpy as np
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", audio_src, "-ac", "1", "-ar", "16000",
                          "-f", "f32le", "-"], capture_output=True, check=True).stdout
    audio = np.frombuffer(pcm, dtype=np.float32)
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segs, _ = model.transcribe(audio, word_timestamps=True, vad_filter=True,
                               language=lang)
    words = [w for s in segs for w in (s.words or [])]
    chunks, cur = [], []
    for w in words:
        cur.append(w)
        if len(cur) == 3 or w.word.strip().endswith((".", "?", "!", ",")):
            chunks.append(cur)
            cur = []
    if cur:
        chunks.append(cur)
    out = [[c[0].start, c[-1].end, " ".join(x.word.strip() for x in c).upper()]
           for c in chunks]
    for i in range(len(out) - 1):  # evita parpadeos: sostener hasta el siguiente si el hueco es corto
        if out[i + 1][0] - out[i][1] < 0.6:
            out[i][1] = out[i + 1][0]
    return out


def build_ass(path, dur, hook_en, hook_es, hook_secs, credit, subs):
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: HookEN,{FONT},92,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,7,3,8,70,70,230,1
Style: HookES,{FONT},58,&H0000E1FF,&H0000E1FF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,5,2,8,70,70,0,1
Style: Sub,{FONT},84,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,7,3,2,80,80,520,1
Style: Credit,{FONT},44,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,1,3,1,2,60,60,300,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ev = []
    hook_end = min(hook_secs, dur)
    if hook_en:
        ev.append(f"Dialogue: 2,{ts(0)},{ts(hook_end)},HookEN,,0,0,0,,{{\\fad(0,250)}}{esc(hook_en).upper()}")
    if hook_es:
        # ES debajo del EN: se calcula un margen aproximado según el largo del EN
        lines_en = max(1, len(hook_en or "") // 18 + 1) if hook_en else 0
        mv = 230 + lines_en * 105 + 10
        ev.append(f"Dialogue: 2,{ts(0)},{ts(hook_end)},HookES,,0,0,{mv},,{{\\fad(0,250)}}{esc(hook_es)}")
    if credit:
        ev.append(f"Dialogue: 1,{ts(0)},{ts(dur)},Credit,,0,0,0,,Clip: {esc(credit)}")
    for s, e, txt in subs:
        ev.append(f"Dialogue: 0,{ts(s)},{ts(e)},Sub,,0,0,0,,{{\\fscx90\\fscy90\\t(0,80,\\fscx100\\fscy100)}}{esc(txt)}")
    with open(path, "w", encoding="utf-8") as f:
        f.write(head + "\n".join(ev) + "\n")


async def tts(text, voice, out):
    import edge_tts
    await edge_tts.Communicate(text, voice, rate="+8%").save(out)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("input")
    p.add_argument("--start", type=float, default=0)
    p.add_argument("--end", type=float)
    p.add_argument("--hook-en", default="")
    p.add_argument("--hook-es", default="")
    p.add_argument("--hook-secs", type=float, default=3.0)
    p.add_argument("--credit", default="", help="@creador (obligatorio para clips de terceros)")
    p.add_argument("--voz", default="", help="texto para la voz IA (se dice al inicio)")
    p.add_argument("--voz-idioma", choices=["es", "en"], default="es")
    p.add_argument("--sin-subs", action="store_true")
    p.add_argument("--sub-idioma", default=None, help="es/en; vacío = autodetectar")
    p.add_argument("--modelo", default="small", help="modelo Whisper: tiny/base/small/medium")
    p.add_argument("--out")
    a = p.parse_args()

    if not a.credit:
        print("AVISO: sin --credit. Solo sin crédito si es material propio.", file=sys.stderr)

    base = os.path.splitext(os.path.basename(a.input))[0]
    out = a.out or os.path.join(os.path.dirname(__file__), "..", "media", "edits", f"{base}_listo.mp4")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        trim = os.path.join(tmp, "trim.mp4")
        cmd = ["ffmpeg", "-y", "-ss", str(a.start), "-i", a.input]
        if a.end:
            cmd += ["-t", str(a.end - a.start)]
        run(cmd + ["-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-c:a", "aac", trim])
        dur = duration(trim)
        has_audio = bool(run(["ffprobe", "-v", "error", "-select_streams", "a",
                              "-show_entries", "stream=index", "-of", "csv=p=0", trim]).strip())

        subs = []
        if has_audio and not a.sin_subs:
            subs = transcribe(trim, a.modelo, a.sub_idioma)

        ass = os.path.join(tmp, "t.ass")
        build_ass(ass, dur, a.hook_en, a.hook_es, a.hook_secs, a.credit, subs)

        inputs = ["-i", trim]
        vf = (f"[0:v]split[a][b];"
              f"[a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=30:3,eq=brightness=-0.15[bg];"
              f"[b]scale={W}:-2[fg];"
              f"[bg][fg]overlay=0:(H-h)/2,fps=30,ass='{ass}'[v]")
        maps = ["-map", "[v]"]
        if a.voz:
            vo = os.path.join(tmp, "voz.mp3")
            asyncio.run(tts(a.voz, VOICES[a.voz_idioma], vo))
            inputs += ["-i", vo]
            if has_audio:
                vf += (";[0:a]volume=0.35[orig];[1:a]volume=1.6[vo];"
                       "[orig][vo]amix=inputs=2:duration=first:normalize=0[aout]")
            else:
                vf += ";[1:a]apad[aout]"
            maps += ["-map", "[aout]"]
        elif has_audio:
            maps += ["-map", "0:a"]

        run(["ffmpeg", "-y", *inputs, "-filter_complex", vf, *maps, "-t", f"{dur:.3f}",
             "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
             "-profile:v", "high", "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
             "-movflags", "+faststart", out])
    print(f"Listo: {os.path.abspath(out)} ({dur:.1f}s)")


if __name__ == "__main__":
    main()
