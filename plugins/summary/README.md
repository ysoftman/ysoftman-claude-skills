# summary mod

Claude Code 세션에서 지금 무슨 일이 일어나고 있는지 한 패널에 모아 보여 주는 mod 다.

| 박스 | 내용 |
| --- | --- |
| 헤더 | 진행 중인 일: ⏳ 메인 턴, 🔧 스킬, 🤖 서브에이전트, 📝 recent 요약 생성 |
| scheduled | session cron 과 다음 실행 시각. cron 이 있을 때만 보인다 |
| recent | 끝난 턴마다 한 줄 요약 (haiku), 경과·소요 시간, 토큰. 요약이 열보다 길면 mod 가 칸 단위로 줄을 나눈다 |
| commands | Claude 와 서브에이전트가 실행한 Bash 명령 최근 10개 중 5줄과 소요 시간 (spinner 실행 중, `✓` 성공, `✗` 실패, `■` plugin 이 막은 명령, 서브에이전트 명령은 흐린 `@<이름>`). 여러 줄 명령은 줄을 ` ↵ ` 로 이어 한 행에 보인다. 백그라운드로 띄운 명령은 시간 대신 `bg` 로, shell 이 도는 동안 `●`, 끝나면 흐린 `○`. 목록 위 휠이나 `▲`/`▼` 로 스크롤한다 |
| git | 브랜치, upstream, ahead/behind, 최근 커밋, 현재 브랜치의 열린 PR (아래 "PR 줄") |
| skills | 실행한 스킬과 모델 |
| turn time | 메인 턴마다 걸린 시간 sparkline |

서브에이전트는 Claude Code 하단 영역에서 보고(패널 헤더에는 실행 중인 개수만 `🤖 N agents` 로 나온다), background shell 은 commands 에 `● bg` 로 보인다.

## 배치

박스는 자주 보는 순서로 놓는다: 곧 실행될 일(scheduled) → 결과(recent, commands) → 저장소 상태(git) → 통계(skills, turn time).

패널 폭과 상관없이 박스는 늘 한 열로 위에서 아래로 놓이고, 모두 패널 폭을 쓴다.

commands 목록 위에서 휠을 굴리면 목록만 움직이고 패널은 그대로다. 목록 밖이거나 명령이 5개 이하면(스크롤할 게 없어 `▲`/`▼` 도 없다) 패널이 스크롤된다. 엔진은 박스별 휠 이벤트를 주지 않으므로, 패널을 그릴 때 목록이 놓인 행(헤더·rule·alerts 와 그 위에 있는 scheduled·recent 의 행 수로 계산)을 기억해 두고 휠이 그 행들 위일 때만 목록을 움직인다. 그 계산이 맞도록 recent 요약은 터미널이 아니라 mod 가 칸 단위로 줄을 나눈다(공백에서 끊고, 한 단어가 줄보다 길면 칸 단위로, 한글은 2칸). 줄마다 잘라서 그리므로 한 줄이 한 행이다. 휠이 닿지 않는 화면에서는 `▲`/`▼` 를 누른다(클릭, 또는 `ctrl+x tab` 후 Tab·Enter). 목록이 맨 위면 새 명령을 따라가고, 내려 보는 중이면 보던 줄이 그 자리에 남는다(가장 오래된 명령이 10개 밖으로 밀려나면 한 줄씩 밀린다). 권한 프롬프트에서 사람이 거부한 명령은 엔진이 오류와 같은 결과로 넘겨 `✗` 로 보인다.

## PR 줄

git 박스에 현재 브랜치의 열린 PR 을 한 줄로 보여 준다. 예: `PR #12 ✅ approved · CI ✔ · 💬 2 unresolved`

| 항목 | 표시 |
| --- | --- |
| draft | `✎ draft` |
| 리뷰 | `✅ approved`, `❌ changes requested`, `👀 review required` |
| CI (마지막 커밋의 check 종합) | `CI ✔`, `CI ✗ failed`, `CI ⋯ running`, check 가 없으면 생략 |
| 미해결 리뷰 스레드 | `💬 N unresolved`, 0 이면 생략 |

approve 됐고 draft 가 아니며 CI 가 통과했거나 없으면 `⇢ ready: merge it in the web UI` 와 PR URL 을 덧붙인다. 머지는 사람이 GitHub 웹 UI 에서 한다.

- `gh` 로그인과 GitHub (Enterprise 포함) remote 가 필요하다. remote 는 gh 처럼 `upstream`, `github`, `origin` 순으로 골라 그 호스트로 `gh api graphql` 을 한 번 부른다. gh 가 없거나 인증이 안 됐거나 열린 PR 이 없으면 줄을 그리지 않는다.
- 필수 리뷰 규칙이 없는 저장소(reviewDecision 없음)는 최신 리뷰에 approve 가 있고 change request 가 없으면 approved 로 본다.
- 남의 fork 에서 같은 브랜치 이름으로 연 PR 은 빼고, 내 fork 에서 연 PR 은 보여 준다.
- 네트워크 호출이라 세션 시작과 턴이 끝날 때 읽되, 직전 조회 후 60초가 안 됐으면 건너뛴다. Bash 로 `git push` 나 `gh pr ...` 를 실행한 직후, 브랜치가 바뀐 뒤 처음 끝나는 턴에는 바로 읽는다. 쉬는 동안 받은 approve 는 다음 턴이 끝날 때 보인다.

## 설치

`/plugin marketplace add ysoftman/ysoftman-claude-skills` 후 `/plugin install summary@ysoftman-claude-skills` 로 설치한다. 개발 중에는 이 폴더를 plugin 디렉터리로 바로 로드한다(hot reload). 둘 중 하나를 쓴다.

- `~/.claude/settings.json` 의 `env.CLAUDE_CODE_PLUGIN_DIRS` 에 이 폴더 경로를 넣는다 (여러 개면 `:` 로 구분).
- `claude --plugin-dir <이 폴더>` 로 실행한다.

myenv 의 `installclaudecode.sh` 는 이 mod 를 `ysoftman-claude-skills` marketplace 에서 설치하고, 아래 단축키도 그 키나 action 이 비어 있을 때만 `keybindings.json` 에 넣어 준다(예전 `app:toggleDiffPreSession` 바인딩은 옮겨 준다).

Claude Code 2.1.296 에서 확인했다 (PR 줄은 2.1.299, commands·scheduled 는 2.1.322).

## 사용

Claude 를 시작하면 패널이 바로 열린다. 다만 엔진은 요청 없이 연 패널을 터미널이 144칸(전에 열어 두고 손으로 닫지 않았다면 110칸) 이상일 때만 그린다. 그보다 좁으면 터미널을 넓히거나 `/summary` 를 실행할 때 보인다. `/reload-plugins` 때는 다시 열지 않는다.

- `/summary`: 패널 열기/닫기. 다른 탭에 가려져 있으면 닫지 않고 앞으로 꺼낸다. 출력은 남기지 않는다.
- `/summary help`: 사용법. 단축키를 설정하지 않았으면 설정 방법도 보여 준다.

## 단축키

plugin 은 단축키를 직접 등록할 수 없어, 각자 `~/.claude/keybindings.json` 에 추가해야 한다. `command:<이름>` action 은 그 슬래시 명령을 입력한 것처럼 실행하므로 `/summary` 를 키에 묶는다.

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "bindings": [
    { "context": "Chat", "bindings": { "ctrl+x s": "command:summary" } },
    {
      "context": "Global",
      "bindings": {
        "ctrl+<": "pane:previous",
        "ctrl+shift+,": "pane:previous",
        "ctrl+>": "pane:next",
        "ctrl+shift+.": "pane:next"
      }
    }
  ]
}
```

이미 `keybindings.json` 이 있으면 파일을 덮어쓰지 말고, `"Chat"`·`"Global"` 블록의 `bindings` 에 위 줄만 추가한다(블록이 없으면 추가하고, 이미 다른 키에 묶은 action 이나 다른 action 에 쓰는 키는 건너뛴다). 예전에 넣은 `"Global"` 의 `"ctrl+x s": "app:toggleDiffPreSession"` 은 지운다.

바인딩하기 전에는 패널 하단과 프롬프트 아래 힌트 줄에 `/summary` 가 보이고, 바인딩하면 그 키가 보인다. 빠진 바인딩이 있으면 패널 하단에 넣을 줄과 함께 설정 안내가 나온다. Claude 에게 "set up shortcuts per the summary mod README"(또는 "summary mod README 대로 단축키 설정해줘") 라고 하면 위 바인딩을 대신 넣어 준다. 다른 키에 묶어도 그 키가 안내에 표시된다.

패널 탭 이동은 엔진 action `pane:previous`/`pane:next` 로 한다. 모든 mod 의 패널을 순서대로 돌고, 기본 키가 없어 `"Global"` 블록에 `"ctrl+<": "pane:previous"`, `"ctrl+>": "pane:next"` 처럼 묶는다(터미널에 따라 `ctrl+shift+,`/`ctrl+shift+.` 로 들어오므로 함께 묶어 둔다). 묶으면 패널 하단에 그 키가 `tabs` 로 보인다.
