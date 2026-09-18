"""渐进页压缩（ADR-012：算法单阶段，不交给 LLM）。

把相邻近似重复页合并成 group，每组只保留一页（信息最全），其余页标记
is_progressive_dup。判定只在本模块发生一次，extract 落盘后 simplify 直接读结果，
绝不重算。

合并判据（P1-FIX 修订）：
1. 短页豁免：归一化长度 < 50 → 仅当完全相同才合并，否则独立成组（reason=short_exempt）。
2. 主判据：行集包含（后一页 ⊇ 前一页）。
3. 兜底判据：coverage = 匹配块长度之和 / min(len(a), len(b))，仅当后一页不短于前一页。

保留页 = 组内归一化字符数最多者；并列取页号最大者。
"""

import difflib
import re
from pathlib import Path

# 短页豁免阈值：归一化后 < 50 字符的页不参与包含/相似度合并（见 ADR-012 / 实施方案 §六）。
SHORT_PAGE_CHARS = 50


def normalize(text: str) -> str:
    """连续空白折叠成一个空格，并 strip 首尾。用于比较与字符统计。"""
    return re.sub(r"\s+", " ", text).strip()


def line_set(text: str) -> set[str]:
    """按行切分 → 逐行 strip → 丢空行 → 得去重后的行集合。"""
    return {line.strip() for line in text.splitlines() if line.strip()}


def coverage(norm_a: str, norm_b: str) -> float:
    """匹配块长度之和 / min(len(a), len(b))。"""
    denom = min(len(norm_a), len(norm_b))
    if denom == 0:
        return 0.0
    sm = difflib.SequenceMatcher(None, norm_a, norm_b)
    matched = sum(block.size for block in sm.get_matching_blocks())
    return matched / denom


def should_merge(norm_a: str, norm_b: str, lines_a: set, lines_b: set, threshold: float) -> bool:
    """相邻两页是否合并：a = 当前组最后一页，b = 待判定的下一页。"""
    # 1. 短页豁免：短页仅当完全相同才合并。
    if len(norm_a) < SHORT_PAGE_CHARS or len(norm_b) < SHORT_PAGE_CHARS:
        return norm_a == norm_b
    # 2. 主判据：行集包含（后一页 ⊇ 前一页）。
    if lines_a and lines_a <= lines_b:
        return True
    # 3. 兜底判据：coverage，仅当后一页不短于前一页。
    if len(norm_b) >= len(norm_a) and coverage(norm_a, norm_b) >= threshold:
        return True
    return False


def diff_added_lines(first_text: str, kept_text: str) -> list[str]:
    """保留页相对该 group 第一页新增的行（difflib 逐行比较）。"""
    first = [l.strip() for l in first_text.splitlines()]
    first = [l for l in first if l]
    kept = [l.strip() for l in kept_text.splitlines()]
    kept = [l for l in kept if l]

    sm = difflib.SequenceMatcher(None, first, kept)
    added: list[str] = []
    for tag, _i1, _i2, j1, j2 in sm.get_opcodes():
        if tag in ("insert", "replace"):
            added.extend(kept[j1:j2])
    return added


def build_extract(source_path: Path, raw_texts: list[str], threshold: float = 0.85) -> dict:
    """对逐页原始文本做渐进页压缩，返回 extract.json 的完整结构。

    raw_texts[i] 为第 i+1 页的提取文本（可能为 ""，表示无文本层）。
    """
    n = len(raw_texts)
    norm = [normalize(t) for t in raw_texts]
    lines = [line_set(t) for t in raw_texts]

    # 顺序贪心分组：groups 是 page 下标（0-based）的 list 的 list。
    groups: list[list[int]] = []
    current = [0]
    for i in range(1, n):
        prev = current[-1]
        if should_merge(norm[prev], norm[i], lines[prev], lines[i], threshold):
            current.append(i)
        else:
            groups.append(current)
            current = [i]
    groups.append(current)

    group_of_page: list[int] = [0] * n
    for gid, g in enumerate(groups):
        for page_idx in g:
            group_of_page[page_idx] = gid

    pages = [
        {
            "page": i + 1,
            "text": raw_texts[i],
            "group": group_of_page[i],
            "is_progressive_dup": False,
        }
        for i in range(n)
    ]

    group_objs = []
    kept_indices: list[int] = []
    kept_override = 0
    for gid, g in enumerate(groups):
        first_idx = g[0]

        # 保留页 = 归一化字符数最多者；并列取页号最大者。
        kept_idx = g[0]
        for pi in g:
            if len(norm[pi]) > len(norm[kept_idx]) or (
                len(norm[pi]) == len(norm[kept_idx]) and pi > kept_idx
            ):
                kept_idx = pi
        if kept_idx != g[-1]:
            kept_override += 1

        if len(g) >= 2:
            reason = "progressive"
        elif len(norm[first_idx]) < SHORT_PAGE_CHARS:
            reason = "short_exempt"
        else:
            reason = "single"

        diff_lines = (
            diff_added_lines(raw_texts[first_idx], raw_texts[kept_idx])
            if len(g) >= 2
            else []
        )

        group_objs.append(
            {
                "group": gid,
                "pages": [p + 1 for p in g],
                "kept_page": kept_idx + 1,  # 页号（1-based），不是数量
                "diff_lines": diff_lines,
                "reason": reason,
            }
        )
        kept_indices.append(kept_idx)

        # group 内除保留页外，其余均为渐进重复页。
        for pi in g:
            if pi != kept_idx:
                pages[pi]["is_progressive_dup"] = True

    chars_before = sum(len(norm[i]) for i in range(n))
    chars_after = sum(len(norm[k]) for k in kept_indices)

    stats = {
        "total_pages": n,
        "groups": len(group_objs),
        "kept_pages": len(kept_indices),
        "kept_override": kept_override,
        "chars_before": chars_before,
        "chars_after": chars_after,
    }

    return {
        "source": str(source_path),
        "pages": pages,
        "groups": group_objs,
        "stats": stats,
    }
