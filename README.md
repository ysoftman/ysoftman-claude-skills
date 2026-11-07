# ysoftman-claude-skills

ysoftman 의 Claude Code 개인 skills, agents, mods.

## 구성

- `skills/` — skills CLI 로 설치하는 skill (이름 접두어 없음)
- `plugins/ysoftman-claude-kit` — agents (`ysoftman-claude-kit:reviewer`, `ysoftman-claude-kit:researcher`, `ysoftman-claude-kit:typo-checker`, `ysoftman-claude-kit:vulnerability-package-checker`)
- `plugins/rule-guard`, `plugins/summary` — mod

## 설치

```bash
# skills
bunx skills add ysoftman/ysoftman-claude-skills --skill '*' -g -a claude-code -y

# agents, mods
claude plugin marketplace add ysoftman/ysoftman-claude-skills
claude plugins install -s user ysoftman-claude-kit@ysoftman-claude-kit
claude plugins install -s user rule-guard@ysoftman-claude-kit
claude plugins install -s user summary@ysoftman-claude-kit
```

같은 skill 을 plugin 으로도 설치하면 이름이 중복되므로 skill 은 skills CLI 로만 설치한다.
