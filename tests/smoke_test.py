"""M1 压缩算法的纯逻辑冒烟测试（plain python，无 pytest 依赖）。

运行：cd <repo root> && python3 tests/smoke_test.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from course_digest import compress  # noqa: E402
from course_digest.import_pdf import slugify  # noqa: E402

P = Path(__file__).resolve().parents[1] / "dummy.pdf"


def check(name, cond):
    if not cond:
        raise AssertionError(f"FAIL: {name}")
    print(f"ok: {name}")


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

    print("ALL PASS")


if __name__ == "__main__":
    main()
