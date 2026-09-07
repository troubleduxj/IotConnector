import fs from 'node:fs';
import path from 'node:path';

/**
 * JSONL 追加写入 + 按大小轮转（#存储优化3）：
 * 超过 maxBytes 时 file → file.1 → file.2（保留 keep 代），防止长期运行无限增长。
 * 轮转的归档代不参与启动恢复（仅主文件），属预期行为。
 */
export function appendJsonl(file: string, line: string, maxBytes = 5_000_000, keep = 2): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* 目录已存在 */
  }
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
      for (let i = keep - 1; i >= 1; i -= 1) {
        const from = `${file}.${i}`;
        const to = `${file}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    /* 轮转失败不阻塞本次写入 */
  }
  fs.appendFileSync(file, line);
}
