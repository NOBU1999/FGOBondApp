// CPython `set` 的**迭代顺序**复刻（只支持"元素 = int 元组"的 set）。
//
// 为什么需要它：search.py::_optimize_free_positions 里是
//     for perm in set(itertools.permutations(current_sids)): ...
// 循环体只接受"严格更优"的解，而**同一侧内部换位不改分数** ⇒ 有多少个并列最优排列是常态，
// 最终留下的那支队伍 = 迭代顺序里**第一个**达到最大分的排列。
// 而 set 的迭代顺序是哈希表槽位顺序（不是插入顺序、不是字典序）——
// 不复刻它，结果里的"谁站哪个位"就会和 Python 不同 → 输出逐字节对不上。
//
// 复刻内容（CPython 3.12，64 位）：
//   · tuple 的 hash：xxHash 变体（PRIME_1=1000003 / PRIME_2=82520 / PRIME_5=97531，左旋 13 位）
//   · 开放寻址插入 + LINEAR_PROBES=9 + PERTURB_SHIFT=5
//   · 扩容：插入后 fill*5 >= mask*3 时 set_table_resize(used*4)，重排时按旧表顺序 clean-insert
//   · 迭代：按槽位 0..mask 顺序产出非空项

const MASK64 = (1n << 64n) - 1n;
// 64 位版本的常量（32 位版本是 1000003 / 82520 / 97531 —— 用错会整体对不上，
// 而"对不上"的表现只是集合顺序乱掉，非常隐蔽）
const PRIME1 = 11400714785074694791n;
const PRIME2 = 14029467366897019727n;
const PRIME5 = 2870177450012600261n;
const ROTATE_BITS = 31n;
const LINEAR_PROBES = 9;
const PERTURB_SHIFT = 5n;
const MINSIZE = 8;

/** Python 的 `hash(int)`：|n| < 2^61-1 时就是 n 本身（-1 特殊成 -2） */
function intLane(v: number): bigint {
  let lane = BigInt(Math.trunc(v));
  if (lane === -1n) lane = -2n;
  return lane & MASK64;
}

/** Python 的 `hash(tuple_of_ints)` */
export function tupleHash(items: number[]): bigint {
  let acc = PRIME5;
  for (const v of items) {
    acc = (acc + intLane(v) * PRIME2) & MASK64;
    acc = ((acc << ROTATE_BITS) | (acc >> (64n - ROTATE_BITS))) & MASK64;
    acc = (acc * PRIME1) & MASK64;
  }
  // ⚠️ 这一步必须全程 BigInt：`len ^ 常数` 里的常数有 62 位，
  // 用 Number 做 `^` 会被截成 32 位（JS 位运算只认 int32）→ 哈希全错。
  acc = (acc + (BigInt(items.length) ^ (PRIME5 ^ 3527539n))) & MASK64;
  if (acc === MASK64) return 1546275796n;
  return acc;
}

function sameTuple(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 把 items 依次插进一个 CPython 语义的 set，然后按**迭代顺序**返回。
 * 等价于 Python 的 `list({tuple(x) for x in items})`（顺序一致）。
 */
export function pySetOrder(items: number[][]): number[][] {
  let size = MINSIZE;
  let mask = size - 1;
  let table: (number[] | null)[] = new Array(size).fill(null);
  let tableHash: bigint[] = new Array(size).fill(0n);
  let fill = 0;

  const insertClean = (key: number[], hash: bigint): void => {
    let perturb = hash;
    let i = Number(hash & BigInt(mask));
    for (;;) {
      if (table[i] === null) {
        table[i] = key;
        tableHash[i] = hash;
        return;
      }
      if (i + LINEAR_PROBES <= mask) {
        for (let j = 0; j < LINEAR_PROBES; j++) {
          const e = i + 1 + j;
          if (table[e] === null) {
            table[e] = key;
            tableHash[e] = hash;
            return;
          }
        }
      }
      perturb >>= PERTURB_SHIFT;
      i = Number((BigInt(i) * 5n + 1n + perturb) & BigInt(mask));
    }
  };

  const resize = (minused: number): void => {
    let newsize = MINSIZE;
    while (newsize <= minused) newsize <<= 1;
    const oldTable = table;
    const oldHash = tableHash;
    const oldSize = size;
    size = newsize;
    mask = size - 1;
    table = new Array(size).fill(null);
    tableHash = new Array(size).fill(0n);
    for (let k = 0; k < oldSize; k++) {
      const k0 = oldTable[k];
      if (k0 !== null) insertClean(k0, oldHash[k]);
    }
  };

  const add = (key: number[], hash: bigint): void => {
    let perturb = hash;
    let i = Number(hash & BigInt(mask));
    let placed = -1;
    for (;;) {
      if (table[i] === null) {
        placed = i;
        break;
      }
      if (tableHash[i] === hash && sameTuple(table[i]!, key)) return;
      if (i + LINEAR_PROBES <= mask) {
        let found = false;
        for (let j = 0; j < LINEAR_PROBES; j++) {
          const e = i + 1 + j;
          if (table[e] === null) {
            placed = e;
            found = true;
            break;
          }
          if (tableHash[e] === hash && sameTuple(table[e]!, key)) return;
        }
        if (found) break;
      }
      perturb >>= PERTURB_SHIFT;
      i = Number((BigInt(i) * 5n + 1n + perturb) & BigInt(mask));
    }
    table[placed] = key;
    tableHash[placed] = hash;
    fill += 1;
    if (fill * 5 >= mask * 3) resize(fill * 4);
  };

  for (const key of items) add(key, tupleHash(key));

  const out: number[][] = [];
  for (let k = 0; k < size; k++) if (table[k] !== null) out.push(table[k]!);
  return out;
}

/** itertools.permutations 的顺序（字典序，最后一个下标变化最快） */
export function permutations<T>(items: T[]): T[][] {
  const n = items.length;
  const out: T[][] = [];
  if (n === 0) return [out as unknown as T[]];
  const idx = items.map((_, i) => i);
  for (;;) {
    out.push(idx.map((i) => items[i]));
    let i = n - 2;
    while (i >= 0 && idx[i] >= idx[i + 1]) i--;
    if (i < 0) break;
    let j = n - 1;
    while (idx[j] <= idx[i]) j--;
    [idx[i], idx[j]] = [idx[j], idx[i]];
    for (let a = i + 1, b = n - 1; a < b; a++, b--) {
      [idx[a], idx[b]] = [idx[b], idx[a]];
    }
  }
  return out;
}

/** Python 的 `set(itertools.permutations(items))` 遍历顺序 */
export function pyPermutationSetOrder(items: number[]): number[][] {
  return pySetOrder(permutations(items));
}
