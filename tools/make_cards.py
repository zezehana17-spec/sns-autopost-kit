"""카드뉴스 이미지 만들기 (4:5, 1080x1350) — 강사 편·리뷰 편 공용

사용법:
    python3 tools/make_cards.py spec.json

spec.json 예시는 tools/example-teacher.json 참고. 예시는 예시일 뿐, 장수·순서·종류·색은 자유.
장 종류: cover, expression, dialogue, list, practice, text(자유 글), image(직접 만든 이미지 한 장), cta
색: "theme" (navy, forest, coral, mono, sky, rose, mint) 또는 "colors"로 내 색 지정
장마다 "dark": true/false 로 진한/밝은 배경을 바꿀 수 있음
결과: public/media/<folder>/card01.jpg ... (spec의 folder)
필요: Python 3, Pillow (pip install pillow), 한글 폰트(Noto Sans CJK 등)
"""
import json, os, sys, glob, textwrap
from PIL import Image, ImageDraw, ImageFont, ImageOps

W, H = 1080, 1350
THEMES = {
    "navy":   {"bg": "#1F2A44", "paper": "#F5EFE3", "accent": "#FFD640", "ink": "#1F2A44", "light": "#F5EFE3"},
    "forest": {"bg": "#24433A", "paper": "#F4F1E8", "accent": "#F2B84B", "ink": "#24433A", "light": "#F4F1E8"},
    "coral":  {"bg": "#3B2C3F", "paper": "#FFF4EC", "accent": "#FF8A65", "ink": "#3B2C3F", "light": "#FFF4EC"},
    "mono":   {"bg": "#111111", "paper": "#FFFFFF", "accent": "#111111", "ink": "#111111", "light": "#FFFFFF"},
    "sky":    {"bg": "#2563EB", "paper": "#F3F7FF", "accent": "#FDE68A", "ink": "#1E293B", "light": "#FFFFFF"},
    "rose":   {"bg": "#9F1239", "paper": "#FFF1F2", "accent": "#FECDD3", "ink": "#4C0519", "light": "#FFFFFF"},
    "mint":   {"bg": "#0F766E", "paper": "#F0FDFA", "accent": "#FDE047", "ink": "#134E4A", "light": "#FFFFFF"},
}
# 테마 대신 내 색을 쓰려면 spec에 "colors": {"bg": "#...", "paper": "#...", "accent": "#...", "ink": "#...", "light": "#..."}
# (bg: 진한 배경, paper: 밝은 배경, accent: 강조색, ink: 밝은 배경 위 글자색, light: 진한 배경 위 글자색)

def find_font(bold=True):
    names = ["NotoSansCJK-Black.ttc", "NotoSansCJK-Bold.ttc", "NotoSansCJKkr-Bold.otf", "NanumGothicBold.ttf", "AppleSDGothicNeo.ttc", "malgunbd.ttf"] if bold \
        else ["NotoSansCJK-Medium.ttc", "NotoSansCJK-Regular.ttc", "NotoSansCJKkr-Regular.otf", "NanumGothic.ttf", "AppleSDGothicNeo.ttc", "malgun.ttf"]
    roots = ["/usr/share/fonts", "/usr/local/share/fonts", os.path.expanduser("~/.fonts"), "/System/Library/Fonts", "/Library/Fonts", "C:/Windows/Fonts"]
    for n in names:
        for r in roots:
            hit = glob.glob(os.path.join(r, "**", n), recursive=True)
            if hit:
                return hit[0]
    sys.exit("한글 폰트를 찾지 못했어요. Noto Sans CJK나 나눔고딕을 설치해 주세요 (예: apt-get install fonts-noto-cjk).")

BOLD, REG = find_font(True), find_font(False)
def F(path, size):
    try:
        return ImageFont.truetype(path, size, index=1 if path.endswith(".ttc") and "CJK" in path else 0)
    except Exception:
        return ImageFont.truetype(path, size)

def wrap(d, text, font, width):
    out = []
    for para in str(text).split("\n"):
        line = ""
        for ch in para:
            if d.textlength(line + ch, font=font) > width and line:
                cut = line.rfind(" ")
                if cut > 0 and cut > len(line) - 12:
                    out.append(line[:cut]); line = line[cut + 1:] + ch
                else:
                    out.append(line); line = ch
            else:
                line += ch
        out.append(line)
    return out

def text_block(d, x, y, text, font, fill, width, gap=14):
    for line in wrap(d, text, font, width):
        d.text((x, y), line, font=font, fill=fill)
        y += font.size + gap
    return y

def pill(d, x, y, text, font, bg, fg):
    tw = d.textlength(text, font=font)
    d.rounded_rectangle((x, y, x + tw + 44, y + font.size + 26), 30, fill=bg)
    d.text((x + 22, y + 10), text, font=font, fill=fg)

def photo(path, w, h):
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    return ImageOps.fit(im, (w, h), Image.LANCZOS)

def page_no(d, i, n, color):
    d.text((W - 60, 56), f"{i}/{n}", font=F(BOLD, 30), fill=color, anchor="ra")

def render(spec, base_dir):
    t = THEMES.get(spec.get("theme", "navy"), THEMES["navy"])
    t = {**t, **spec.get("colors", {})}
    slides = spec["slides"]
    n = len(slides)
    out_dir = os.path.join(base_dir, "public", "media", spec["folder"])
    os.makedirs(out_dir, exist_ok=True)
    files = []
    for i, s in enumerate(slides, start=1):
        kind = s.get("type")
        dark = s.get("dark", kind in ("cover", "expression", "cta"))
        if kind == "image":  # 직접 만든 이미지(캔바 등)를 그대로 한 장으로
            im = photo(os.path.join(base_dir, s["file"]), W, H)
            path = os.path.join(out_dir, f"card{i:02d}.jpg"); im.save(path, quality=92); files.append(path)
            continue
        im = Image.new("RGB", (W, H), t["bg"] if dark else t["paper"])
        d = ImageDraw.Draw(im)
        fg = t["light"] if dark else t["ink"]
        if s.get("photo"):
            ph = photo(os.path.join(base_dir, s["photo"]), W, 760 if kind != "cover" else H)
            if kind == "cover":
                im.paste(ph, (0, 0))
                shade = Image.new("RGBA", (W, H), (0, 0, 0, 0))
                sd = ImageDraw.Draw(shade)
                for yy in range(H // 3, H):
                    sd.line((0, yy, W, yy), fill=(0, 0, 0, int(200 * (yy - H / 3) / (H * 2 / 3))))
                im.paste(shade, (0, 0), shade); d = ImageDraw.Draw(im)
            else:
                im.paste(ph, (0, 0))
        page_no(d, i, n, fg)
        if kind == "cover":
            if s.get("label"): pill(d, 60, 60, s["label"], F(BOLD, 34), t["accent"], t["ink"])
            y = H - 520
            y = text_block(d, 60, y, s.get("title", ""), F(BOLD, 112), fg, W - 120, 18)
            if s.get("sub"): text_block(d, 62, y + 20, s["sub"], F(REG, 40), t["accent"], W - 120)
        elif kind == "expression":
            if s.get("label"): pill(d, 60, 90, s["label"], F(BOLD, 34), t["accent"], t["ink"])
            y = text_block(d, 60, 400, s.get("en", ""), F(BOLD, 112), t["accent"], W - 120, 16)
            y = text_block(d, 60, y + 30, s.get("ko", ""), F(BOLD, 66), fg, W - 120)
            if s.get("note"): text_block(d, 60, y + 60, s["note"], F(REG, 46), fg, W - 120)
        elif kind == "dialogue":
            y = 760 + 50 if s.get("photo") else 220
            if s.get("label"): pill(d, 60, y, s["label"], F(BOLD, 34), t["bg"], t["light"]); y += 110
            for line in s.get("lines", []):
                who = line.get("who", "")
                d.text((60, y), who, font=F(BOLD, 48), fill=t["bg"])
                y = text_block(d, 150, y, line.get("en", ""), F(BOLD, 56), t["ink"], W - 210, 10)
                if line.get("ko"): y = text_block(d, 150, y, line["ko"], F(REG, 40), "#777777", W - 210, 8)
                y += 50
        elif kind == "list":
            y = 220
            if s.get("label"): pill(d, 60, y, s["label"], F(BOLD, 34), t["bg"], t["light"]); y += 120
            if s.get("title"): y = text_block(d, 60, y, s["title"], F(BOLD, 72), t["ink"], W - 120) + 50
            for item in s.get("items", []):
                d.ellipse((60, y + 26, 78, y + 44), fill=t["bg"])
                y = text_block(d, 100, y, item, F(BOLD, 54), t["ink"], W - 160, 10) + 40
        elif kind == "practice":
            y = 220
            pill(d, 60, y, s.get("label", "내 문장으로"), F(BOLD, 34), t["bg"], t["light"]); y += 140
            y = text_block(d, 60, y, s.get("prompt", ""), F(BOLD, 66), t["ink"], W - 120) + 50
            for _ in range(int(s.get("blanks", 2))):
                d.line((60, y + 60, W - 60, y + 60), fill="#C9C1B0", width=4); y += 110
            if s.get("hint"): text_block(d, 60, y + 30, s["hint"], F(REG, 38), "#777777", W - 120)
        elif kind == "cta":
            d.text((W // 2, 520), s.get("title", "저장해두고"), font=F(BOLD, 88), fill=fg, anchor="mm")
            d.text((W // 2, 640), s.get("sub", "필요할 때 꺼내 쓰세요"), font=F(BOLD, 64), fill=t["accent"], anchor="mm")
            if s.get("handle"): d.text((W // 2, 820), s["handle"], font=F(BOLD, 56), fill=fg, anchor="mm")
            if s.get("note"): d.text((W // 2, 900), s["note"], font=F(REG, 36), fill=fg, anchor="mm")
        elif kind == "text":  # 자유 글 한 장 (제목 + 본문)
            tf, bf = F(BOLD, int(s.get("size", 72))), F(REG, int(s.get("body_size", 46)))
            hgt = (120 if s.get("label") else 0) \
                + (len(wrap(d, s.get("title", ""), tf, W - 120)) * (tf.size + 14) + 40 if s.get("title") else 0) \
                + (len(wrap(d, s.get("body", ""), bf, W - 120)) * (bf.size + 18) if s.get("body") else 0)
            y = 760 + 50 if s.get("photo") else max(160, (H - hgt) // 2 - 40)
            if s.get("label"): pill(d, 60, y, s["label"], F(BOLD, 34), t["accent"] if dark else t["bg"], t["ink"] if dark else t["light"]); y += 120
            if s.get("title"): y = text_block(d, 60, y, s["title"], F(BOLD, int(s.get("size", 72))), t["accent"] if dark else t["ink"], W - 120) + 40
            if s.get("body"): text_block(d, 60, y, s["body"], F(REG, int(s.get("body_size", 46))), fg, W - 120, 18)
        else:
            sys.exit(f"{i}장: 모르는 type '{kind}' (cover, expression, dialogue, list, practice, text, image, cta)")
        path = os.path.join(out_dir, f"card{i:02d}.jpg")
        im.save(path, quality=92)
        files.append(path)
    return files

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    spec_path = sys.argv[1]
    spec = json.load(open(spec_path, encoding="utf-8"))
    base = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    files = render(spec, base)
    if not 2 <= len(files) <= 10:
        print("주의: 인스타 캐러셀은 2~10장이에요.")
    if spec.get("outbox"):
        o = spec["outbox"]
        post = {"id": o["id"], "account": o.get("account", "main"), "channel": "card", "publishAt": o.get("publishAt", ""),
                "caption": o.get("caption", ""), "images": [f"/media/{spec['folder']}/{os.path.basename(f)}" for f in files]}
        with open(os.path.join(base, "outbox", f"{o['id']}.json"), "w", encoding="utf-8") as fp:
            json.dump(post, fp, ensure_ascii=False, indent=2)
        print("outbox 글 생성:", f"outbox/{o['id']}.json")
    print("\n".join(files))
