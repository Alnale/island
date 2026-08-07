"""bili 扫码登录辅助(终端二维码显示不便时的备用):生成 PNG 二维码 +
轮询确认 + 按 bili-tool 同款格式落盘 cookies.json。
用法: python qr-login-helper.py [输出目录]
落盘: <输出目录>/cookies.json(bili-tool 的 auth_cookie 读取同款
SESSDATA/bili_jct/DedeUserID)+ <输出目录>/login-qrcode.png(扫码用)"""
import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import qrcode

out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'config'
)
os.makedirs(out_dir, exist_ok=True)


def get(url: str):
    req = urllib.request.Request(
        url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    )
    return json.load(urllib.request.urlopen(req, timeout=15))


d = get('https://passport.bilibili.com/x/passport-login/web/qrcode/generate')
if d.get('code') != 0:
    print('生成二维码失败:', d.get('message'))
    sys.exit(1)
url, key = d['data']['url'], d['data']['qrcode_key']
png = os.path.join(out_dir, 'login-qrcode.png')
qrcode.make(url).save(png)
print(f'二维码已保存: {png}')
print('请用手机 B 站 App 扫码并确认(2 分钟内有效)...')

start = time.time()
while time.time() - start < 140:
    time.sleep(3)
    try:
        r = get(f'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key={key}')
    except Exception as e:  # noqa: BLE001
        print('poll 失败:', e)
        continue
    # B 站新版响应:顶层 code 恒为 0,真正状态在 data.code
    # (86101 等待扫码 / 86090 已扫码待确认 / 86038 失效 / 0 登录成功)
    code = (r.get('data') or {}).get('code', r.get('code', -1))
    if code == 0:
        # 调试:成功响应完整结构(url 是否为空 / refresh_token 等)
        print('poll 成功响应:', json.dumps(r, ensure_ascii=False)[:500])
        url = r.get('data', {}).get('url', '') or ''
        # 解析 data.url 的 query 参数(SESSDATA/bili_jct/DedeUserID 等)
        cookies = {}
        for seg in url.split('?')[-1].split('&'):
            if '=' in seg:
                k, v = seg.split('=', 1)
                cookies[k] = v
        # B 站新版流程:poll 的 url 是 crossDomain?ticket=xxx 中转地址,
        # SESSDATA 等 cookie 在请求该地址的 Set-Cookie 里(302 跳转到
        # www.bilibili.com 时下发)。**必须手动逐跳解析**:urllib cookiejar
        # 有域策略检查(biligame.com 设置 .bilibili.com 的 cookie 被拒绝,
        # 实测拿不到);与 bili-tool 的 fetch_cookies_chain(reqwest Jar,
        # 不做域检查)等价
        if not cookies.get('SESSDATA') and url:
            try:
                current = url
                seen = set()
                for _ in range(6):
                    if current in seen:
                        break
                    seen.add(current)
                    req = urllib.request.Request(
                        current,
                        headers={
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                            'Cookie': '; '.join(f'{k}={v}' for k, v in cookies.items()),
                        },
                    )
                    try:
                        resp = urllib.request.urlopen(req, timeout=15)
                    except urllib.error.HTTPError as e:
                        resp = e  # 3xx 重定向会抛 HTTPError,头仍可读
                    for h in resp.headers.get_all('Set-Cookie') or []:
                        name, _, rest = h.partition('=')
                        cookies.setdefault(name.strip(), rest.split(';')[0])
                    loc = resp.headers.get('Location')
                    if not loc:
                        break
                    current = urllib.parse.urljoin(current, loc)
            except Exception as e:  # noqa: BLE001
                print('crossDomain 获取 cookie 失败:', e)
        if not cookies.get('SESSDATA'):
            print('登录响应缺少 SESSDATA,请重试')
            sys.exit(1)
        with open(os.path.join(out_dir, 'cookies.json'), 'w', encoding='utf-8') as f:
            json.dump(cookies, f, ensure_ascii=False, indent=2)
        print(f"登录成功! UID={cookies.get('DedeUserID', '?')},cookies.json 已写入 {out_dir}")
        sys.exit(0)
    msg = {86038: '二维码已失效,请重跑', 86090: '已扫码,请在手机上确认', 86101: '等待扫码'}.get(
        code, f'未知状态 {code}'
    )
    print(f'[{msg}]')
print('登录超时')
sys.exit(1)
