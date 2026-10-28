"""拡張機能のアイコン（16/32/48/128px）を作る。

緑の角丸の上に、1 本の白い線で描いたメモ用紙。紙のふちを描いた線が、右下の角から猫のしっぽになって終わる。
絵は 96 の格子で決めてある。線の太さは 6 で、線の中心を 16px の画素の真ん中に置いているので、32px でも線がにじまない。
16px だけは、しっぽの曲線が小さすぎてにじむので、白い線を 1 画素ずつ置く。
48px と 128px はストアの決まりに合わせて、まわりに 16/128 の透明な余白を取る。16px と 32px はツールバー用なので余白なし。
大きく描いてから縮小し、ふちを滑らかにする。
使い方: python3 tools/make_icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
S = 1024  # 下書きの大きさ
GRID = 96  # 絵の格子
TILE = (15, 157, 118, 255)
WHITE = (255, 255, 255, 255)
STROKE = 6
RADIUS = 22

# 紙のふちからしっぽまでの 1 本の線と、紙の中の 3 本の行。SVG の path と同じ書き方
OUTLINE = [
    ("M", 57, 81), ("H", 24), ("Q", 15, 81, 15, 72), ("V", 30), ("Q", 15, 21, 24, 21),
    ("H", 60), ("Q", 69, 21, 69, 30), ("V", 63),
    ("C", 69, 75, 75, 81, 81, 77), ("C", 87, 73, 87, 63, 81, 64),
]
ROWS = [
    [("M", 27, 39), ("H", 57)],
    [("M", 27, 51), ("H", 57)],
    [("M", 27, 63), ("H", 45)],
]

# 16px の白い線。# が白い画素。上の線を 16px に置き直し、しっぽは右へ回って上を向く
SMALL = [
    "................",
    "................",
    "................",
    "...########.....",
    "..#........#....",
    "..#........#....",
    "..#.######.#....",
    "..#........#....",
    "..#.######.#....",
    "..#........#....",
    "..#.####...#..#.",
    "..#........#..#.",
    "..#.........##..",
    "...#######......",
    "................",
    "................",
]


def flatten(path, steps=32):
    """曲線を細かい点に分けて、折れ線の点の並びにする。"""
    points = []
    x = y = 0
    for cmd, *args in path:
        if cmd == "M":
            x, y = args
            points.append((x, y))
        elif cmd == "H":
            x = args[0]
            points.append((x, y))
        elif cmd == "V":
            y = args[0]
            points.append((x, y))
        elif cmd == "Q":
            cx, cy, ex, ey = args
            for i in range(1, steps + 1):
                t = i / steps
                points.append((
                    (1 - t) ** 2 * x + 2 * (1 - t) * t * cx + t ** 2 * ex,
                    (1 - t) ** 2 * y + 2 * (1 - t) * t * cy + t ** 2 * ey,
                ))
            x, y = ex, ey
        elif cmd == "C":
            c1x, c1y, c2x, c2y, ex, ey = args
            for i in range(1, steps + 1):
                t = i / steps
                a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3
                points.append((a * x + b * c1x + c * c2x + d * ex, a * y + b * c1y + c * c2y + d * ey))
            x, y = ex, ey
    return points


def draw_icon(padded, lines=True):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 余白ありは 128 のうち 96 に絵を置く。余白なしは全面に置く
    offset = S * 16 / 128 if padded else 0
    unit = (S - 2 * offset) / GRID

    def at(p):
        return (offset + p[0] * unit, offset + p[1] * unit)

    d.rounded_rectangle([at((0, 0)), at((GRID, GRID))], radius=RADIUS * unit, fill=TILE)
    if not lines:
        return img
    width = STROKE * unit
    for path in [OUTLINE, *ROWS]:
        points = [at(p) for p in flatten(path)]
        d.line(points, fill=WHITE, width=round(width), joint="curve")
        # 線の両端を丸くする
        for px, py in (points[0], points[-1]):
            d.ellipse([px - width / 2, py - width / 2, px + width / 2, py + width / 2], fill=WHITE)
    return img


def draw_small():
    img = draw_icon(padded=False, lines=False).resize((16, 16), Image.BOX)
    for y, row in enumerate(SMALL):
        for x, cell in enumerate(row):
            if cell == "#":
                img.putpixel((x, y), WHITE)
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    padded = draw_icon(padded=True)
    icons = {16: draw_small(), 32: draw_icon(padded=False), 48: padded, 128: padded}
    for size, icon in icons.items():
        icon.resize((size, size), Image.BOX).save(OUT / f"icon{size}.png")
        print(f"wrote icon{size}.png")


if __name__ == "__main__":
    main()
