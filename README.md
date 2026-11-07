# ysoftman-claude-skills

ysoftman 의 Claude Code 개인 skills, agents, mods.

## 구성

- `skills/` — skills CLI 로 설치하는 skills
- `plugins/` — claude plugin 으로 설치하는 agents,mods

## 설치

```bash
# skills (사용시 /접두어: 를 사용하지 않고 바로 /스킬이름  으로 사용할 수 있다.)
bunx skills add ysoftman/ysoftman-claude-skills --skill '*' -g -a claude-code -y

# agents, mods
claude plugin marketplace add ysoftman/ysoftman-claude-skills
claude plugins install -s user ysoftman-agents@ysoftman-claude-skills
claude plugins install -s user rule-guard@ysoftman-claude-skills
claude plugins install -s user summary@ysoftman-claude-skills
```

같은 skill 을 plugin 으로도 설치하면 이름이 중복되므로 skill 은 skills CLI 로만 설치한다.
