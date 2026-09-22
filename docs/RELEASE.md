# 发布门禁

构建前运行 `pnpm check`，生成发布目录后运行：

```powershell
node scripts/audit-release.mjs --strict
```

门禁要求：发行目录不超过 450 MB、仅包含一套 Electron 运行时、不得包含
`settings.json`、隐私配置或本地审计日志。审计脚本默认只报告；`--strict`
会在违反门禁时返回失败。
