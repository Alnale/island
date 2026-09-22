"""QR 编码器对拍(开发期验证,2026-09-22):stdin 收 JSON
{text, mask} → 输出 python qrcode 的矩阵('0'/'1' 逐行),与
qr.ts 的 encodeQr 结果逐格比对(相同 mask 下应完全一致)。
用法: echo '{"text":"...","mask":0}' | python tests/qr-crosscheck.py
"""
import json
import sys

import qrcode

req = json.load(sys.stdin)
text = req.get('text', 'https://txz.qq.com/p?k=test')
mask = req.get('mask', 0)

qr = qrcode.QRCode(
    version=None,
    error_correction=qrcode.constants.ERROR_CORRECT_M,
    box_size=1,
    border=0,
    mask_pattern=mask,
)
# 强制 byte 模式(qr.ts 只实现 byte;python 默认会为纯大写/数字选
# 字母数字模式,码流不同则矩阵天然不同,对拍必须同模式)
qr.add_data(qrcode.util.QRData(text, mode=qrcode.util.MODE_8BIT_BYTE))
qr.make(fit=True)
matrix = qr.get_matrix()
print(json.dumps({'size': len(matrix), 'rows': [''.join('1' if c else '0' for c in row) for row in matrix]}))
