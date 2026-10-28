// 画像に印（四角・矢印・文字）を付ける。
// 描いた印は覚えておき、変わるたびに元の画像から描き直す（「1 つ戻す」ができるように）。
// 線の太さや文字の大きさは画像の大きさに合わせる（大きなスクリーンショットでも見えるように）。
// 置いた文字は、ドラッグで動かせる（動かすのも「1 つ戻す」で戻せる）。

export const COLORS = { red: '#e11d48', blue: '#2563eb', yellow: '#facc15' };
// 文字の大きさ（画像の長い辺に対する割合の倍率）
export const TEXT_SIZES = { small: 0.7, medium: 1, large: 1.5 };

function drawArrow(g, { x1, y1, x2, y2, width }) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = width * 4;
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2 - Math.cos(angle) * head * 0.8, y2 - Math.sin(angle) * head * 0.8);
  g.stroke();
  g.beginPath();
  g.moveTo(x2, y2);
  g.lineTo(x2 - head * Math.cos(angle - 0.45), y2 - head * Math.sin(angle - 0.45));
  g.lineTo(x2 - head * Math.cos(angle + 0.45), y2 - head * Math.sin(angle + 0.45));
  g.closePath();
  g.fill();
}

function drawShape(g, shape) {
  g.strokeStyle = shape.color;
  g.fillStyle = shape.color;
  g.lineWidth = shape.width;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (shape.tool === 'rect') {
    g.strokeRect(Math.min(shape.x1, shape.x2), Math.min(shape.y1, shape.y2), Math.abs(shape.x2 - shape.x1), Math.abs(shape.y2 - shape.y1));
  } else if (shape.tool === 'arrow') {
    drawArrow(g, shape);
  } else if (shape.tool === 'text') {
    // 白いふちを付けて、どんな背景でも読めるようにする
    g.font = `bold ${shape.size}px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif`;
    g.textBaseline = 'middle';
    g.lineWidth = Math.max(3, shape.size / 5);
    g.strokeStyle = '#ffffff';
    g.strokeText(shape.text, shape.x, shape.y);
    g.fillText(shape.text, shape.x, shape.y);
  }
}

// textInput は「文字」で入れる文字の欄。onChange(印の数) は印が変わったとき
export function createAnnotator({ canvas, textInput, onChange }) {
  const g = canvas.getContext('2d');
  let bitmap = null;
  let shapes = [];
  let drawing = null;
  let tool = 'rect';
  let color = COLORS.red;
  let textScale = TEXT_SIZES.medium;
  let moving = null; // { index, dx, dy, before }（ドラッグで動かしている文字）
  let history = []; // 「1 つ戻す」で戻す操作（'add' か、文字を動かす前の位置）

  const longSide = () => Math.max(canvas.width, canvas.height);
  const lineWidth = () => Math.max(3, Math.round(longSide() / 300));
  const fontSize = () => Math.max(12, Math.round((longSide() / 40) * textScale));

  // その位置にある、置いた文字（後から置いたものを優先）
  function textAt(x, y) {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const shape = shapes[i];
      if (shape.tool !== 'text') continue;
      g.font = `bold ${shape.size}px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif`;
      const width = g.measureText(shape.text).width;
      if (x >= shape.x && x <= shape.x + width && Math.abs(y - shape.y) <= shape.size * 0.6) return i;
    }
    return -1;
  }

  function redraw() {
    if (!bitmap) return;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bitmap, 0, 0);
    for (const shape of drawing ? [...shapes, drawing] : shapes) drawShape(g, shape);
    onChange?.(shapes.length);
  }

  // 画面上の位置を、画像の中の位置にする（画像は縮めて表示している）
  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * canvas.width) / rect.width,
      y: ((event.clientY - rect.top) * canvas.height) / rect.height,
    };
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!bitmap) return;
    const { x, y } = point(event);
    const hit = textAt(x, y);
    if (hit >= 0) {
      canvas.setPointerCapture(event.pointerId);
      const shape = shapes[hit];
      moving = { index: hit, dx: x - shape.x, dy: y - shape.y, before: { x: shape.x, y: shape.y } };
      return;
    }
    if (tool === 'text') {
      const text = textInput.value.trim();
      if (!text) {
        textInput.focus();
        return;
      }
      shapes.push({ tool, color, x, y, text, size: fontSize() });
      history.push({ type: 'add' });
      redraw();
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    drawing = { tool, color, x1: x, y1: y, x2: x, y2: y, width: lineWidth() };
  });

  canvas.addEventListener('pointermove', (event) => {
    if (moving) {
      const { x, y } = point(event);
      shapes[moving.index] = { ...shapes[moving.index], x: x - moving.dx, y: y - moving.dy };
      redraw();
      return;
    }
    if (!drawing) {
      // 置いた文字の上では、動かせることが分かるカーソルにする
      const at = point(event);
      if (bitmap) canvas.style.cursor = textAt(at.x, at.y) >= 0 ? 'move' : '';
      return;
    }
    const { x, y } = point(event);
    drawing.x2 = x;
    drawing.y2 = y;
    redraw();
  });

  const finish = () => {
    if (moving) {
      const shape = shapes[moving.index];
      if (shape.x !== moving.before.x || shape.y !== moving.before.y) history.push({ type: 'move', index: moving.index, ...moving.before });
      moving = null;
      return;
    }
    if (!drawing) return;
    // 押しただけ（ほとんど動かしていない）のものは印にしない
    if (Math.hypot(drawing.x2 - drawing.x1, drawing.y2 - drawing.y1) > lineWidth() * 2) {
      shapes.push(drawing);
      history.push({ type: 'add' });
    }
    drawing = null;
    redraw();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  return {
    async start(blob) {
      bitmap = await createImageBitmap(blob);
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      shapes = [];
      history = [];
      drawing = null;
      moving = null;
      redraw();
    },
    stop() {
      bitmap?.close();
      bitmap = null;
      shapes = [];
      history = [];
      drawing = null;
      moving = null;
    },
    setTool(value) {
      tool = value;
    },
    setColor(value) {
      color = COLORS[value] ?? COLORS.red;
    },
    setTextSize(value) {
      textScale = TEXT_SIZES[value] ?? TEXT_SIZES.medium;
    },
    undo() {
      const last = history.pop();
      if (last?.type === 'move') shapes[last.index] = { ...shapes[last.index], x: last.x, y: last.y };
      else shapes.pop();
      redraw();
    },
    marks: () => shapes.length,
    toBlob: () => new Promise((resolve) => canvas.toBlob(resolve, 'image/png')),
  };
}
