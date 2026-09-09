#!/usr/bin/env python3
# Renders demo/demo.gif from the real captured session (demo/transcript-raw.txt).
# Pure PIL terminal renderer: progressive line reveal, Catppuccin-mocha theme.
# Run: python demo/render_gif.py
import re
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "transcript-raw.txt"
OUT = ROOT / "demo.gif"

BG, HEADER, FG = (30, 30, 46), (24, 24, 37), (205, 214, 244)
BLUE, GRAY, GREEN, YELLOW = (137, 180, 250), (108, 112, 134), (166, 227, 161), (249, 226, 175)
W, FONT_SIZE, LINE_H, PAD, HEAD_H = 890, 15, 22, 20, 40

FONT = ImageFont.truetype(r"C:\Windows\Fonts\consola.ttf", FONT_SIZE)


def clean(raw: str) -> list[str]:
    text = raw.replace("\ufeff", "")
    text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-B]", "", text)
    text = text.replace("\r", "")
    for bad, good in [("ΓÜÖ", "⚙"), ("┬╖", "·"), ("ΓÇö", "—"), ("ΓÇô", "–")]:
        text = text.replace(bad, good)
    keep = []
    for ln in text.split("\n"):
        s = ln.strip()
        if not s:
            continue
        if s.startswith(("opencode.exe", "At ", "+ ", "CategoryInfo", "FullyQualifiedErrorId")):
            continue
        keep.append(s)
    return keep


def wrap(line: str, max_w: int, draw: ImageDraw) -> list[str]:
    words, out, cur = line.split(" "), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if draw.textlength(trial, font=FONT) <= max_w:
            cur = trial
        else:
            if cur:
                out.append(cur)
            cur = w
    if cur:
        out.append(cur)
    return out or [""]


def colorize(line: str):
    # returns list of (segment, color)
    if line.startswith("you>"):
        return [("you>", BLUE), (line[4:], FG)]
    if line.startswith("⚙"):
        return [(line, GRAY)]
    if line.startswith(">"):
        return [(line, GRAY)]
    for prefix, color in [("Codex's answer:", GREEN), ("Gemini's verdict:", YELLOW)]:
        if line.startswith(prefix):
            return [(prefix, color), (line[len(prefix):], FG)]
    return [(line, FG)]


def main():
    kept = clean((RAW).read_text(encoding="utf-8-sig"))
    # Curated but faithful session order: host line, mention, tool, answer, mention, tool, verdict.
    host = next((l for l in kept if l.startswith(">")), "> build · free/glm-5.3-flash")
    ask = next((l for l in kept if "huddle_ask" in l), "")
    check = next((l for l in kept if "huddle_check" in l), "")
    codex = next((l for l in kept if "Codex's answer:" in l), "Codex's answer: 5")
    gemini = next((l for l in kept if "Gemini's verdict:" in l), "")
    seq = [
        host,
        "you> @codex what does add(2,3) in calc.ts return? Just the value.",
        "⚙ " + ask,
        codex,
        "you> @gemini check what codex did — was it right?",
        "⚙ " + check,
        gemini,
    ]
    (ROOT / "transcript.txt").write_text("\n".join(kept) + "\n", encoding="utf-8")

    probe = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    wrapped: list[list[tuple[str, tuple]]] = []
    for line in seq:
        parts = colorize(line)
        # wrap on plain text, then re-split colors for first chunk only (simple + correct for our lines)
        plain = "".join(p[0] for p in parts)
        chunks = wrap(plain, W - PAD * 2, probe)
        first = True
        for ch in chunks:
            if first:
                # simple approach: color leading known prefix if chunk starts with it
                segs = colorize(ch) if any(ch.startswith(p) for p in ("you>", "⚙", ">", "Codex's answer:", "Gemini's verdict:")) else [(ch, FG)]
                wrapped.append(segs)
                first = False
            else:
                wrapped.append([("  " + ch, FG)])

    H = HEAD_H + PAD + len(wrapped) * LINE_H + PAD + LINE_H
    frames = []
    for n in range(1, len(wrapped) + 1):
        img = Image.new("RGB", (W, H), BG)
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, W, HEAD_H], fill=HEADER)
        for cx, col in ((22, (243, 139, 168)), (42, (249, 226, 175)), (62, (166, 227, 161))):
            d.ellipse([cx - 6, 12, cx + 6, 24], fill=col)
        d.text((W // 2, 12), "opencode — session (host) + huddle", font=FONT, fill=FG, anchor="ma")
        y = HEAD_H + PAD
        for segs in wrapped[:n]:
            x = PAD
            for seg, col in segs:
                d.text((x, y), seg, font=FONT, fill=col)
                x += d.textlength(seg, font=FONT)
            y += LINE_H
        last_w = d.textlength("".join(s for s, _ in wrapped[n - 1]), font=FONT)
        d.rectangle([PAD + last_w + 2, y - LINE_H + 4, PAD + last_w + 11, y - 2], fill=FG)
        frames.append(img)

    durations = [450] * (len(frames) - 1) + [2800]
    frames[0].save(OUT, save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True)
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB, {len(frames)} frames, {W}x{H})")


main()
