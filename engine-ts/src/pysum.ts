// 复刻 CPython 3.12+ `sum()` 的浮点补偿求和（Neumaier）。
// 为什么必须：Python 3.12 给 `sum()` 加了浮点专用快路径（Neumaier 补偿），
// 结果与"朴素左到右累加"在最后一位上可能不同（实测 1 ULP），
// 而我们的验收判据是"逐字节/逐值一致"，差 1 ULP 就会判失败。
export function pySum(values: number[]): number {
  let total = 0;
  let c = 0;
  for (const x of values) {
    const t = total + x;
    if (Math.abs(total) >= Math.abs(x)) c += total - t + x;
    else c += x - t + total;
    total = t;
  }
  return total + c;
}
