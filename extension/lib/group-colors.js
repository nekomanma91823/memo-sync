// グループの色。
// 自分で選んだ色は Chrome の同期機能（chrome.storage.sync の groupColors）に置き、ほかの PC にも届ける
// （メモを Google ドライブで同期しているときも、色は Chrome の同期機能で届く）。
// 選んでいないグループには、まだ使われていない色を並んでいる順に割り当てる。
//   groupColors   { [グループの名前]: 色の名前（'blue' など） }

export const GROUP_COLOR_KEY = 'groupColors';

export const GROUP_COLORS = {
  blue: { label: '青', hex: '#2f8fd8' },
  orange: { label: '橙', hex: '#e08a2e' },
  green: { label: '緑', hex: '#3fa34d' },
  purple: { label: '紫', hex: '#7b61d6' },
  pink: { label: '桃', hex: '#d353a0' },
  yellow: { label: '黄', hex: '#c9a400' },
  red: { label: '赤', hex: '#e05252' },
  gray: { label: '灰', hex: '#6b7785' },
};

const KEYS = Object.keys(GROUP_COLORS);

// 読んだ値の形を確かめる（知らない色や長すぎる名前は捨てる）
export function cleanGroupColors(value, maxName = 30) {
  const colors = {};
  if (!value || typeof value !== 'object') return colors;
  for (const [name, key] of Object.entries(value)) {
    if (typeof name === 'string' && name && name.length <= maxName && KEYS.includes(key)) colors[name] = key;
  }
  return colors;
}

export async function readGroupColors(area) {
  const { [GROUP_COLOR_KEY]: value } = await area.get(GROUP_COLOR_KEY);
  return cleanGroupColors(value);
}

// names は並んでいる順のグループの名前、chosen は選んだ色。返り値は { [名前]: 色の名前 }
export function assignGroupColors(names, chosen = {}) {
  const result = {};
  const used = new Set(names.map((name) => chosen[name]).filter((key) => KEYS.includes(key)));
  let next = 0;
  for (const name of names) {
    if (KEYS.includes(chosen[name])) {
      result[name] = chosen[name];
      continue;
    }
    // 選ばれていない色から順に使う。全部使っていたら、並び順で重ねる
    const free = KEYS.filter((key) => !used.has(key));
    const key = free.length ? free[next % free.length] : KEYS[names.indexOf(name) % KEYS.length];
    next++;
    result[name] = key;
  }
  return result;
}

// グループの名前を変えたとき・やめたときの色の記録。to が空ならその色の記録を消す
export function renameGroupColor(colors, from, to) {
  const next = { ...colors };
  const key = next[from];
  delete next[from];
  if (to && key) next[to] = key;
  return next;
}
