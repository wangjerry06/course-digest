"""course-digest —— 本地课件总结查看器。

本包采用 flat layout，从仓库根目录 `python3 -m course_digest` 直接可用。

pypdf 以 vendored 形式放在 `_vendor/pypdf/`，其内部使用绝对自引用
（`from pypdf.`），不能当作子包导入。必须把 `_vendor` 注入 `sys.path`，
让 `pypdf` 成为顶层可导入名 —— 这必须在任何 `import pypdf` 之前执行。
"""

import sys
from pathlib import Path

_vendor = Path(__file__).parent / "_vendor"
if str(_vendor) not in sys.path:
    sys.path.insert(0, str(_vendor))
