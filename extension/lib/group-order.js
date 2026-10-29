// グループの並び。
// 並べ替えた順は Chrome の同期機能（chrome.storage.sync の groupOrder）に置き、ほかの PC にも届ける
// （メモを Google ドライブで同期しているときも、並びは Chrome の同期機能で届く）。
// 並べ替えたことのないグループは、メモの並びで初めて出てくる順に、後ろへ足す。
// やめたグループの名前は記録に残しておく（「元に戻す」で同じ場所に戻すため）。次に並べ替えたときに消える。
//   groupOrder   [グループの名前, …]

export const GROUP_ORDER_KEY = 'groupOrder';

const MAX_NAMES = 200;

// 読んだ値の形を確かめる（名前でないもの・長すぎる名前・重なりは捨てる）
export function cleanGroupOrder(value, maxName = 30) {
  if (!Array.isArray(value)) return [];
  const names = [];
  for (const name of value) {
    if (names.length >= MAX_NAMES) break;
    if (typeof name === 'string' && name && name.length <= maxName && !names.includes(name)) names.push(name);
  }
  return names;
}

export async function readGroupOrder(area) {
  const { [GROUP_ORDER_KEY]: value } = await area.get(GROUP_ORDER_KEY);
  return cleanGroupOrder(value);
}

// names はメモの並びで初めて出てくる順のグループの名前。並べ替えた順のものを先に、残りを後ろに並べる
export function sortGroups(names, order = []) {
  const placed = order.filter((name) => names.includes(name));
  return [...placed, ...names.filter((name) => !placed.includes(name))];
}

// shown は今の並び。name を target の前（after なら後ろ）に動かした並びを返す
export function placeGroup(shown, name, target, after = false) {
  if (name === target || !shown.includes(name) || !shown.includes(target)) return shown;
  const next = shown.filter((other) => other !== name);
  next.splice(next.indexOf(target) + (after ? 1 : 0), 0, name);
  return next;
}

// name を step だけ左（負）か右（正）に動かした並びを返す。端から先には動かさない
export function stepGroup(shown, name, step) {
  const from = shown.indexOf(name);
  const to = from + step;
  if (from < 0 || to < 0 || to >= shown.length) return shown;
  const next = [...shown];
  next.splice(from, 1);
  next.splice(to, 0, name);
  return next;
}

// グループの名前を変えたときの並びの記録。同じ場所に新しい名前を置く
export function renameGroupOrder(order, from, to) {
  if (!order.includes(from)) return order;
  return order.filter((name) => name !== to).map((name) => (name === from ? to : name));
}
