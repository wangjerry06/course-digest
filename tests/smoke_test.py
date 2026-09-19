"""M1 压缩算法的纯逻辑冒烟测试（plain python，无 pytest 依赖）。

运行：cd <repo root> && python3 tests/smoke_test.py
"""

import contextlib
import io
import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from course_digest import compress  # noqa: E402
from course_digest import paths, simplify  # noqa: E402
from course_digest.import_pdf import slugify  # noqa: E402
from pypdf import PdfReader, PdfWriter  # noqa: E402

P = Path(__file__).resolve().parents[1] / "dummy.pdf"


def check(name, cond):
    if not cond:
        raise AssertionError(f"FAIL: {name}")
    print(f"ok: {name}")


def raises(exc_type, fn, *a, **kw):
    try:
        fn(*a, **kw)
    except exc_type:
        return True
    return False


def quiet(fn, *a, **kw):
    """跑一个会往 stdout/stderr 打日志的函数，把噪音吞掉。"""
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return fn(*a, **kw)


def make_fixture_doc(root: Path, doc_id: str, groups: list[dict], n_pages: int):
    """造一个只有 source.pdf + extract.json 的假文档（页是空白的，simplify 不看文本）。"""
    doc_dir = root / doc_id
    doc_dir.mkdir(parents=True)
    writer = PdfWriter()
    for _ in range(n_pages):
        writer.add_blank_page(width=200.0, height=300.0)
    with open(doc_dir / "source.pdf", "wb") as fh:
        writer.write(fh)

    dup = {p for g in groups for p in g["pages"] if p != g["kept_page"]}
    extract_json = {
        "source": str(doc_dir / "source.pdf"),
        "pages": [
            {
                "page": i + 1,
                "text": "",
                "group": next(
                    (gi for gi, g in enumerate(groups) if i + 1 in g["pages"]), -1
                ),
                "is_progressive_dup": (i + 1) in dup,
            }
            for i in range(n_pages)
        ],
        "groups": groups,
        "stats": {
            "total_pages": n_pages,
            "groups": len(groups),
            "kept_pages": len(groups),
            "kept_override": 0,
            "chars_before": 0,
            "chars_after": 0,
            "split_by_guard": 0,
        },
    }
    (doc_dir / "extract.json").write_text(
        json.dumps(extract_json, ensure_ascii=False), encoding="utf-8"
    )
    return doc_dir


def _g(gid, pages, kept, reason):
    return {"group": gid, "pages": pages, "kept_page": kept, "diff_lines": [], "reason": reason}


def main():
    # slugify 规则
    check("slug lower+hyphen", slugify("Lecture-02 C++ FUNDAMENTALS") == "lecture-02-c-fundamentals")
    check("slug 40-char truncate", len(slugify("a" * 100)) == 40)
    check("slug strip hyphens", slugify("__foo__") == "foo")

    # 渐进页合并：page2 与 page3 只差一行，应归入同一 group，kept_page=3
    base = "\n".join(
        [
            "#include <iostream>",
            "using namespace std;",
            "int add(int a, int b) { return a + b; }",
            "int sub(int a, int b) { return a - b; }",
            "int main() {",
            "  cout << add(1, 2) << endl;",
            "  cout << sub(3, 1) << endl;",
            "  return 0;",
            "}",
        ]
    )
    p2 = base + "\n02"
    p3 = base + "\nFrom today, we assume this program structure.\n02"
    p1 = "Lecture 02: C++ Fundamentals\n02"
    r = compress.build_extract(P, [p1, p2, p3], 0.85)
    check("3 pages -> 2 groups", r["stats"]["groups"] == 2)
    g1 = r["groups"][1]
    check("group1 pages [2,3]", g1["pages"] == [2, 3])
    check("kept_page == 3", g1["kept_page"] == 3)
    check("reason progressive", g1["reason"] == "progressive")
    check("page2 is dup", r["pages"][1]["is_progressive_dup"] is True)
    check("page3 not dup", r["pages"][2]["is_progressive_dup"] is False)
    check("diff_lines has new line", any("From today" in l for l in g1["diff_lines"]))

    # 短页豁免：Chapter 3 vs Chapter 4 不得合并
    r2 = compress.build_extract(P, ["Chapter 3", "Chapter 4"], 0.85)
    check("chapter pages not merged", r2["stats"]["groups"] == 2)
    check("both short_exempt", all(g["reason"] == "short_exempt" for g in r2["groups"]))

    # 完全相同短页仍合并
    r3 = compress.build_extract(P, ["Slide 12", "Slide 12"], 0.85)
    check("identical short merged", r3["stats"]["groups"] == 1)
    check("identical reason progressive", r3["groups"][0]["reason"] == "progressive")

    # chars 统计：归一化后字符数（折叠空白、strip 首尾）
    r4 = compress.build_extract(P, ["  hello   world  ", "hello world"], 0.85)
    check("chars_before normalized", r4["stats"]["chars_before"] == 2 * len("hello world"))
    check("chars_after == one page", r4["stats"]["chars_after"] == len("hello world"))

    # P1-FIX 新用例 (a)：后页真包含前页且增长 > 50% → 应合并
    base_lines = [
        "#include <iostream>",
        "using namespace std;",
        "int add(int a, int b) { return a + b; }",
        "int sub(int a, int b) { return a - b; }",
        "int main() {",
        "  cout << add(1, 2) << endl;",
        "  cout << sub(3, 1) << endl;",
        "  return 0;",
        "}",
    ]
    extra_lines = [
        "// ---- extra content ----",
        "double mul(double x, double y) { return x * y; }",
        "double div(double x, double y) { return x / y; }",
        "int mod(int x, int y) { return x % y; }",
        "void print_done() { cout << \"done\" << endl; }",
        "int fac(int n) { return n <= 1 ? 1 : n * fac(n - 1); }",
        "int main_extra() { return 0; }",
    ]
    a_txt = "\n".join(base_lines)
    b_txt = "\n".join(base_lines + extra_lines)
    check(
        "fix(a) growth > 50%",
        len(compress.normalize(b_txt)) > 1.5 * len(compress.normalize(a_txt)),
    )
    r5 = compress.build_extract(P, [a_txt, b_txt], 0.85)
    check("fix(a) superset merged", r5["stats"]["groups"] == 1)
    check("fix(a) kept = longer page", r5["groups"][0]["kept_page"] == 2)
    check("fix(a) earlier page dup", r5["pages"][0]["is_progressive_dup"] is True)

    # P1-FIX 新用例 (b)：后页是前页的删减（反向包含）→ 不应合并
    r6 = compress.build_extract(P, [b_txt, a_txt], 0.85)
    check("fix(b) reverse-subset not merged", r6["stats"]["groups"] == 2)

    # --- P2 新用例 (a)：成员页相对保留页 coverage < 0.90 应被拆出 ---
    # 造一条链 a→b→c（每页与前一页都够像），但 c 把 a 那一段整个换掉了：
    # 只有 b 真正被 c 包含，a 没有 → a 必须被拆出来。
    # 文本用正常句子而非重复符号：difflib 的 autojunk 会把重复出现的字符当噪音，
    # 那样 matcher 什么都匹配不到，测不出真实行为。
    g_a = (
        "Memory layout matters for cache performance. "
        "Arrays keep neighbouring elements together."
    )
    g_x = " ".join(
        [
            "The compiler translates source into machine instructions.",
            "Each function call pushes a frame onto the runtime stack.",
            "Local variables live inside that frame and die with it.",
            "Pointers hold addresses, references hide the same idea.",
            "Undefined behaviour means the standard imposes no requirement.",
            "Templates are instantiated at compile time, not at runtime.",
            "Move semantics transfer ownership instead of copying buffers.",
            "Const correctness documents which parts a function may touch.",
            "Iterators generalize pointers across many container types.",
            "Exceptions unwind the stack while running destructors.",
            "Virtual dispatch costs one indirect jump per call site.",
            "Alignment requirements force padding between struct members.",
            "A translation unit is one preprocessed source file.",
            "Linkers resolve symbols and relocate addresses at build time.",
            "Headers should be self contained and include what they use.",
            "The standard library algorithms operate on iterator ranges.",
            "Value categories decide whether a temporary may be reused.",
            "Initialization order across translation units is unspecified.",
            "Namespaces prevent collisions between unrelated libraries.",
            "Overload resolution ranks conversions before templates.",
        ]
    )
    g_b = g_a + " " + g_x
    g_c = (
        g_x + " The professor packed this slide with administrative details."
        " Remember to submit the lab report before the deadline."
    )
    na, nb, nc = (compress.normalize(t) for t in (g_a, g_b, g_c))
    check("guard premise: a,b merge", compress.coverage(na, nb) >= 0.85)
    check("guard premise: b,c merge", compress.coverage(nb, nc) >= 0.85)
    check("guard premise: a not covered by c", compress.coverage(na, nc) < 0.90)
    r7 = compress.build_extract(P, [g_a, g_b, g_c], 0.85)
    check("guard split_by_guard == 1", r7["stats"]["split_by_guard"] == 1)
    check("guard groups == 2", r7["stats"]["groups"] == 2)
    check("guard kept_pages == 2", r7["stats"]["kept_pages"] == 2)
    check("guard group0 == [1] single", r7["groups"][0]["pages"] == [1])
    check("guard page1 reason single", r7["groups"][0]["reason"] == "single")
    check("guard group1 == [2,3]", r7["groups"][1]["pages"] == [2, 3])
    check("guard page1 no longer dup", r7["pages"][0]["is_progressive_dup"] is False)
    check(
        "guard chars_after counts page1",
        r7["stats"]["chars_after"] == len(na) + len(nc),
    )

    # 单页组不参与校验（没有成员页可拆），且校验是幂等的 no-op
    # P3-FIX：返回值从「拆出次数(int)」改为「被拆出的页号列表(升序)」
    check(
        "guard no-op on single group",
        compress.apply_coverage_guard([[5]], [""] * 6) == ([[5]], []),
    )
    check(
        "guard returns page index list",
        compress.apply_coverage_guard([list(range(3))], [na, nb, nc])[1] == [0],
    )

    # --- P3-FIX (b)：无文本层页早退，永不合并 ---
    content = compress.normalize("Real content on this slide. " * 3)
    check(
        "(b) should_merge('', content) is False",
        compress.should_merge("", content, compress.line_set(""), compress.line_set(content), 0.85)
        is False,
    )
    check(
        "(b) should_merge(content, '') is False",
        compress.should_merge(content, "", compress.line_set(content), compress.line_set(""), 0.85)
        is False,
    )
    check(
        "(b) should_merge('', '') is False",
        compress.should_merge("", "", compress.line_set(""), compress.line_set(""), 0.85) is False,
    )
    check(
        "(b) whitespace-only page counts as empty",
        compress.should_merge("", compress.normalize("   \n\t "), set(), set(), 0.85) is False,
    )

    # --- P3-FIX (c)：全空文本层 6 页 → 全单页组、reason 全 no_text、guard 不触发 ---
    r_empty = compress.build_extract(P, [""] * 6, 0.85)
    check("(c) 6 empty pages -> 6 groups", r_empty["stats"]["groups"] == 6)
    check("(c) kept_pages == total_pages", r_empty["stats"]["kept_pages"] == 6)
    check("(c) split_by_guard == 0", r_empty["stats"]["split_by_guard"] == 0)
    check("(c) all reasons no_text", {g["reason"] for g in r_empty["groups"]} == {"no_text"})
    check("(c) chars_before 0", r_empty["stats"]["chars_before"] == 0)
    check("(c) all pages kept, no dup", not any(p["is_progressive_dup"] for p in r_empty["pages"]))

    # --- P3-FIX (d)：空页夹在内容页之间 → 空页独立成组、reason == no_text ---
    d_1 = "Dynamic dispatch costs one indirect jump per call site. Templates are instantiated early."
    d_2 = d_1 + " Undefined behaviour means the standard imposes no requirement whatsoever."
    d_4 = "Administrative announcements belong on this separate slide and match nothing else."
    r_mid = compress.build_extract(P, [d_1, d_2, "", d_4], 0.85)
    check("(d) 4 pages -> 3 groups", r_mid["stats"]["groups"] == 3)
    check("(d) group0 == [1,2] progressive", r_mid["groups"][0]["pages"] == [1, 2])
    check("(d) group0 kept == 2", r_mid["groups"][0]["kept_page"] == 2)
    check("(d) group1 == [3] no_text", r_mid["groups"][1]["pages"] == [3])
    check("(d) group1 reason no_text", r_mid["groups"][1]["reason"] == "no_text")
    check("(d) group2 == [4] single", r_mid["groups"][2]["pages"] == [4])
    check("(d) group2 reason single", r_mid["groups"][2]["reason"] == "single")
    check("(d) empty page not dup", r_mid["pages"][2]["is_progressive_dup"] is False)
    check("(d) split_by_guard == 0", r_mid["stats"]["split_by_guard"] == 0)

    # --- P3-FIX (a)：simplify 不再接受 --threshold ---
    from course_digest import __main__ as cli  # noqa: E402

    # argparse 会把 usage 打到 stderr，这里吞掉以免污染测试输出
    with contextlib.redirect_stderr(io.StringIO()):
        threshold_rejected = raises(
            SystemExit, cli.main, ["simplify", "some-doc", "--threshold", "0.9"]
        )
    check("(a) simplify --threshold exits non-zero", threshold_rejected)
    simp_ns = cli.build_parser().parse_args(["simplify", "some-doc", "--drop", "3"])
    check("(a) simplify namespace has no threshold", not hasattr(simp_ns, "threshold"))
    check("(a) simplify --drop still parsed", simp_ns.drop == "3")
    ext_ns = cli.build_parser().parse_args(["extract", "some-doc"])
    check("(a) extract --threshold default kept", ext_ns.threshold == 0.85)

    # --- P3-FIX (e)：guard 触发时 stderr 有 warning，stdout 首行仍 6 字段 ---
    from course_digest import extract as ex  # noqa: E402

    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        ex._warn_guard_splits([])
    check("(e) no split -> stderr silent", err.getvalue() == "")

    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        ex._warn_guard_splits([12, 50])
    check(
        "(e) warning text",
        err.getvalue()
        == "warning: coverage guard split 2 page(s) out of their groups: P12, P50 "
        "(text not fully covered by the kept page; ADR-012 safety net)\n",
    )

    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        ex._print_summary(r_mid)
    first_line = out.getvalue().splitlines()[0]
    fields = dict(kv.split("=", 1) for kv in first_line.split(" "))
    check(
        "(e) stdout first line is 6 fields",
        list(fields) == [
            "total_pages",
            "groups",
            "kept_pages",
            "kept_override",
            "chars_before",
            "chars_after",
        ],
    )
    check("(e) stdout has no split_by_guard", "split_by_guard" not in first_line)

    # --- P2: parse_drop ---
    check("parse_drop mixed", simplify.parse_drop("3,7,9-11", 285) == [3, 7, 9, 10, 11])
    check("parse_drop dedup+sort", simplify.parse_drop("5,3-4,4", 285) == [3, 4, 5])
    check("parse_drop empty spec", simplify.parse_drop("", 285) == [])
    check("parse_drop out of range", raises(ValueError, simplify.parse_drop, "9999", 285))
    check("parse_drop garbage", raises(ValueError, simplify.parse_drop, "abc", 285))
    check("parse_drop reversed", raises(ValueError, simplify.parse_drop, "11-9", 285))

    # --- P2: simplify 端到端（假文档，不动真实数据目录）---
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        saved = paths.DOCS_DIR
        paths.DOCS_DIR = root
        try:
            # (b) --drop 删光所有页 → 报错退出，且不产出任何文件
            make_fixture_doc(root, "b1", [_g(0, [1, 2, 3], 3, "progressive")], 3)
            rc = quiet(
                simplify.run, SimpleNamespace(doc_id="b1", drop="1-3", threshold=None)
            )
            check("(b) drop-all rc == 1", rc == 1)
            check("(b) no simplified.pdf", not (root / "b1" / "simplified.pdf").exists())
            check("(b) no page-map.json", not (root / "b1" / "page-map.json").exists())

            # 其余边界：越界页号、非法规格
            check(
                "(b) out-of-range rc == 1",
                quiet(
                    simplify.run,
                    SimpleNamespace(doc_id="b1", drop="9999", threshold=None),
                )
                == 1,
            )
            check(
                "(b) malformed spec rc == 1",
                quiet(
                    simplify.run,
                    SimpleNamespace(doc_id="b1", drop="abc", threshold=None),
                )
                == 1,
            )

            # (c) 未传 --drop → 不得出现 reason="manual"
            groups = [
                _g(0, [1, 2, 3], 3, "progressive"),
                _g(1, [4], 4, "single"),
                _g(2, [5, 6], 6, "progressive"),
            ]
            doc = make_fixture_doc(root, "c1", groups, 6)
            rc = quiet(simplify.run, SimpleNamespace(doc_id="c1", drop=None, threshold=None))
            check("(c) rc == 0", rc == 0)
            pm = json.loads((doc / "page-map.json").read_text(encoding="utf-8"))
            check("(c) no manual reason", all(d["reason"] != "manual" for d in pm["dropped"]))
            check("(c) dropped == dup 1,2,5", pm["dropped"] == [
                {"page": 1, "reason": "dup"},
                {"page": 2, "reason": "dup"},
                {"page": 5, "reason": "dup"},
            ])
            check("(c) merged dup range 1-2", pm["dropped_ranges"] == [
                {"from": 1, "to": 2, "reason": "dup"},
                {"from": 5, "to": 5, "reason": "dup"},
            ])
            check("(c) total_simplified == 3", pm["total_simplified"] == 3)
            check("(c) orig_to_simp null for dup", pm["orig_to_simp"]["1"] is None)
            check("(c) orig_to_simp kept", [
                pm["orig_to_simp"][k] for k in ("3", "4", "6")
            ] == [1, 2, 3])
            check("(c) simp_to_orig", pm["simp_to_orig"] == {"1": 3, "2": 4, "3": 6})
            check("(c) pdf pages == 3", len(PdfReader(str(doc / "simplified.pdf")).pages) == 3)

            # 幂等：连跑两次，page-map.json 完全一致
            first = (doc / "page-map.json").read_bytes()
            quiet(simplify.run, SimpleNamespace(doc_id="c1", drop=None, threshold=None))
            check("(c) idempotent", (doc / "page-map.json").read_bytes() == first)

            # 传 --drop：manual 单独记录，且不与相邻的 dup 合并成区间
            rc = quiet(simplify.run, SimpleNamespace(doc_id="c1", drop="4", threshold=None))
            check("(c) rc == 0 with --drop", rc == 0)
            pm2 = json.loads((doc / "page-map.json").read_text(encoding="utf-8"))
            check("(c) manual recorded", [
                d for d in pm2["dropped"] if d["reason"] == "manual"
            ] == [{"page": 4, "reason": "manual"}])
            check("(c) manual not merged with dup", pm2["dropped_ranges"] == [
                {"from": 1, "to": 2, "reason": "dup"},
                {"from": 4, "to": 4, "reason": "manual"},
                {"from": 5, "to": 5, "reason": "dup"},
            ])
            check("(c) total_simplified == 2", pm2["total_simplified"] == 2)
            check("(c) re-run pdf pages == 2", len(PdfReader(str(doc / "simplified.pdf")).pages) == 2)

            # 可逆性：simp_to_orig 的每个值都能被 orig_to_simp 反查回同一个键
            reversible = all(
                pm2["orig_to_simp"][str(orig)] == int(simp)
                for simp, orig in pm2["simp_to_orig"].items()
            )
            check("(c) mapping reversible", reversible)

            # 单页文档不崩
            make_fixture_doc(root, "one", [_g(0, [1], 1, "single")], 1)
            rc = quiet(simplify.run, SimpleNamespace(doc_id="one", drop=None, threshold=None))
            check("(c) 1-page doc rc == 0", rc == 0)
            check(
                "(c) 1-page pdf has 1 page",
                len(PdfReader(str(root / "one" / "simplified.pdf")).pages) == 1,
            )

            # --- P3-FIX (f)：dup 与 manual 撞车仍记 dup（回归，补文档不得改行为）---
            # P1 是 group0 的保留页，P2 是 group1 的重复页，P3 是 group1 的保留页。
            make_fixture_doc(
                root,
                "f1",
                [_g(0, [1], 1, "single"), _g(1, [2, 3], 3, "progressive")],
                3,
            )
            rc = quiet(
                simplify.run, SimpleNamespace(doc_id="f1", drop="1,2", threshold=None)
            )
            check("(f) rc == 0", rc == 0)
            pmf = json.loads(
                (root / "f1" / "page-map.json").read_text(encoding="utf-8")
            )
            check(
                "(f) dup wins over manual (P2)",
                [x for x in pmf["dropped"] if x["page"] == 2] == [{"page": 2, "reason": "dup"}],
            )
            check(
                "(f) kept page dropped manually is manual (P1)",
                [x for x in pmf["dropped"] if x["page"] == 1]
                == [{"page": 1, "reason": "manual"}],
            )
            check(
                "(f) manual count counts only F1 losses",
                [x["page"] for x in pmf["dropped"] if x["reason"] == "manual"] == [1],
            )
            check("(f) total_simplified == 1", pmf["total_simplified"] == 1)
            check(
                "(f) ranges not merged across reasons",
                pmf["dropped_ranges"]
                == [
                    {"from": 1, "to": 1, "reason": "manual"},
                    {"from": 2, "to": 2, "reason": "dup"},
                ],
            )
        finally:
            paths.DOCS_DIR = saved

    print("ALL PASS")


if __name__ == "__main__":
    main()
