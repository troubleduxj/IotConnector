# -*- coding: utf-8 -*-
"""合并 i18n 片段到 src/i18n.tsx，并校验所有 t('...') 字面量键已入词典。"""
import json, re, io, sys, glob, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # apps/console
TSX = os.path.join(ROOT, 'src', 'i18n.tsx')
FRAG = os.path.join(ROOT, 'scripts', 'i18n-fragments.json')

APP_ADD = {
    'role.admin': ('管理员', 'Administrator'),
    'role.engineer': ('工程师', 'Engineer'),
    'role.operator': ('操作员', 'Operator'),
    'header.switchLang': ('切换语言 / Switch language', 'Switch language / 切换语言'),
}

src = io.open(TSX, encoding='utf-8').read()

def parse_block(name):
    m = re.search(r"const %s: Record<string, string> = \{(.*?)\n\};" % name, src, re.S)
    pairs = re.findall(r"'((?:[^'\\]|\\.)+)':\s*'((?:[^'\\]|\\.)*)'", m.group(1))
    return {k.replace("\\'", "'"): v.replace("\\'", "'") for k, v in pairs}

zh, en = parse_block('zh'), parse_block('en')
frag_files = sys.argv[1:] or [FRAG]
for path in frag_files:
    frag = json.load(io.open(path, encoding='utf-8'))
    for ns, d in frag.items():
        for k, v in d['zh'].items():
            if k in zh and zh[k] != v:
                print('WARN zh 冲突覆盖:', k, '|', zh[k], '->', v)
            zh[k] = v
        for k, v in d['en'].items():
            en[k] = v

for k, (zv, ev) in APP_ADD.items():
    zh[k], en[k] = zv, ev

# zh/en 键集合一致性
only_zh = set(zh) - set(en)
only_en = set(en) - set(zh)
if only_zh or only_en:
    print('FATAL 键集合不一致 zh-only:', sorted(only_zh), 'en-only:', sorted(only_en))
    sys.exit(1)

def dump(d):
    lines = []
    for k in sorted(d):
        v = (d[k].replace('\\', '\\\\').replace("'", "\\'")
                 .replace('\r', '\\r').replace('\n', '\\n').replace('\t', '\\t'))
        lines.append("  '%s': '%s'," % (k, v))
    return '\n'.join(lines)

new_src = re.sub(r"(const zh: Record<string, string> = \{).*?(\n\};)",
                 lambda m: m.group(1) + '\n' + dump(zh) + m.group(2), src, flags=re.S)
new_src = re.sub(r"(const en: Record<string, string> = \{).*?(\n\};)",
                 lambda m: m.group(1) + '\n' + dump(en) + m.group(2), new_src, flags=re.S)
io.open(TSX, 'w', encoding='utf-8', newline='\n').write(new_src)
print('词典已合并: zh=%d en=%d' % (len(zh), len(en)))

# ===== 覆盖校验：提取所有 t('...') / t("...") 字面量键 =====
used = set()
for f in glob.glob(os.path.join(ROOT, 'src', 'views', '*.tsx')) + [os.path.join(ROOT, 'src', 'App.tsx')]:
    for m in re.finditer(r"\bt\(\s*'([^']+)'", io.open(f, encoding='utf-8').read()):
        used.add(m.group(1))
missing = sorted(k for k in used if k not in zh)
print('t() 字面量键共 %d 个, 缺失 %d 个' % (len(used), len(missing)))
for k in missing:
    print('  MISSING:', k)
sys.exit(2 if missing else 0)
