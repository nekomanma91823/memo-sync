"""拡張機能のアイコン（16/32/48/128px）を作る。

緑の角丸の上に、番号タブの付いた白いメモ用紙。選んでいるタブ（左）だけ山吹色にする。
メモの画面のタブと同じ形にして、ほかのメモアプリと見分けやすくする。
大きく描いてから縮小し、ふちを滑らかにする。
使い方: python3 tools/make_icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
S = 1024  # 下書きの大きさ
TOP = (34, 150, 122)  # 背景のグラデーション（上）
BOTTOM = (15, 98, 82)  # 背景のグラデーション（下）
WHITE = (255, 255, 255, 255)
LINE = (24, 117, 97, 255)
TAB_ON = (247, 184, 64, 255)
TAB_OFF = (150, 220, 196, 255)


def background():
    gradient = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(gradient)
    for y in range(S):
        t = y / (S - 1)
        d.line([(0, y), (S, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)) + (255,))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([48, 48, S - 48, S - 48], radius=230, fill=255)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(gradient, (0, 0), mask)
    return img


def draw_icon():
    img = background()
    d = ImageDraw.Draw(img)
    left, right, top, bottom = 222, 802, 352, 836

    # 奥の 2 つのタブ
    for x in (left + 200, left + 400):
        d.rounded_rectangle([x, 258, x + 170, top + 60], radius=46, fill=TAB_OFF)

    # 用紙の影
    shade = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shade).rounded_rectangle([left, top + 18, right, bottom + 18], radius=64, fill=(0, 0, 0, 60))
    img.alpha_composite(shade)
    d = ImageDraw.Draw(img)

    # 用紙と、用紙につながった選んでいるタブ
    d.rounded_rectangle([left, top, right, bottom], radius=64, fill=WHITE)
    d.rounded_rectangle([left, 248, left + 170, top + 40], radius=46, fill=TAB_ON)
    d.rectangle([left, top, left + 170, top + 26], fill=TAB_ON)

    # 罫線
    for i, end in enumerate([right - 86, right - 86, right - 250]):
        y = 470 + i * 112
        d.rounded_rectangle([left + 86, y, end, y + 50], radius=25, fill=LINE)
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    icon = draw_icon()
    for size in (16, 32, 48, 128):
        icon.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
        print(f"wrote icon{size}.png")


if __name__ == "__main__":
    main()
