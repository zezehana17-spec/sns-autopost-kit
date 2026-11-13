# ARCHITECTURE.md — 구조 설명서

## 한 장 요약

```
[사용자 폰] 사진·영상 + 한 줄 평
     │  (Claude 프로젝트 "내 SNS 편집실" 대화창)
     ▼
[Claude] 편집: 릴스(자막·음악) · 카드뉴스(4:5) · 캡션 · 스레드 글
     │  git push: outbox/<id>.json + public/media/<폴더>/<파일>
     ▼
[GitHub 저장소] ──push──▶ [Vercel] 자동 배포 (미디어가 공개 주소로 열림)
     │
     │  GitHub Actions: 30분마다 + push 2분 반 뒤 → POST /api/run
     │  (Vercel 크론: 하루 1번 예비 실행)
     ▼
[api/run.js]
     ├─ 예약 시각 지난 글 발행 (한 번에 최대 3개)
     │    threads → 스레드 (긴 글은 답글로 이어 붙임)
     │    card    → 인스타 캐러셀
     │    reel    → 인스타 릴스 (컨테이너 만들기 → 다음 실행에서 처리 끝나면 게시)
     ├─ 결과 저장 → Upstash Redis (post:<id>)
     └─ 스레드 토큰 연장 (일주일에 한 번, 암호화해서 저장)
     ▼
[/admin] 계정 확인 · 목록(예약됨/발행완료/실패) · 지금 발행 · 멈추기 · 테스트 글 · 자동 실행 값 · 스레드 토큰 장기 변환
```

## 왜 이렇게 생겼나

- Claude 작업 공간은 일반 웹 주소로 요청을 못 보내지만 GitHub에는 올릴 수 있다 → "GitHub에 올리면 발행"
- 무료 Vercel(Hobby)은 크론이 하루 1번 → 30분마다 깨우는 일은 GitHub Actions
- 인스타는 영상·이미지를 공개 주소에서 가져간다 → 미디어는 Vercel 정적 파일(public/media)
- 무료 Vercel 함수는 60초 제한 → 릴스는 실행 두 번에 나눠서 처리
- 외부 패키지 없음 (Node 20 기본 기능만) → 버전 문제로 깨질 일이 적다

## 파일

```
api/run.js        발행 실행 (CRON_SECRET 필요)
api/admin.js      관리 화면 API (ADMIN_CODE 필요)
lib/kit.js        발행·저장·토큰 공용 코드
public/admin.html 관리 화면 (/admin)
public/index.html 첫 화면
public/media/     Claude가 올리는 완성 미디어
outbox/           Claude가 올리는 글 (1글 = 1파일, _로 시작하면 무시)
.github/workflows/publish.yml  30분마다 실행
vercel.json       함수 설정(outbox 포함, 60초), 예비 크론
test/run-test.js  가짜 API로 전체 흐름 테스트 (npm test)
```

## outbox 글 형식

```json
{
  "id": "2026-11-13-lacuesta-reel",
  "account": "main",
  "channel": "reel",
  "publishAt": "2026-11-13 12:00",
  "caption": "인스타 캡션 (해시태그 포함)",
  "video": "/media/20261113-lacuesta-q7m2/reel.mp4"
}
```

| channel | 필요한 칸 |
|---|---|
| reel | video (/media/…mp4), caption |
| card | images (/media/…jpg 2~10장, 4:5), caption |
| threads | body (길면 자동으로 답글로 나눔) |

- publishAt: 한국 시간 "YYYY-MM-DD HH:MM". 비우면 다음 실행 때 바로
- account: 계정이 여러 개일 때만 (기본 main)
- 한 번 발행된 id는 다시 발행되지 않는다. 실패는 3번까지 자동 재시도 후 멈춤

## 환경변수 (Vercel)

| 이름 | 필수 | 내용 |
|---|---|---|
| IG_TOKEN | 인스타 쓰면 | 시스템 사용자 토큰 EAA… (또는 인스타 로그인 토큰 IG…) |
| IG_USER_ID | 인스타 쓰면 | 인스타 프로페셔널 계정 숫자 ID |
| THREADS_TOKEN | 스레드 쓰면 | 장기 토큰 (60일, 앱이 자동 연장) |
| THREADS_APP_SECRET | 선택 | 단기 스레드 토큰을 장기로 바꿀 때만 |
| ADMIN_CODE | 예 | 관리 화면 비밀번호 |
| CRON_SECRET | 예 | /api/run 호출 비밀값 (토큰 암호화 키로도 씀 → 바꾸면 스레드 토큰을 다시 넣어야 함) |
| UPSTASH_REDIS_REST_URL / TOKEN | 예 | Vercel Storage에서 Upstash 연결하면 자동 (KV_REST_API_URL / TOKEN도 인식) |
| SITE_URL | 선택 | 사이트 주소. 없으면 Vercel 기본 주소 |
| META_GRAPH_VERSION | 선택 | 기본 v26.0 |

계정이 여러 개면 `IG_TOKEN_CAFE`, `IG_USER_ID_CAFE`, `THREADS_TOKEN_CAFE`처럼 붙이고 outbox의 account에 `cafe`.

## 지켜야 할 것

- 토큰은 저장소에 절대 넣지 않는다 (Vercel 환경변수에만)
- 저장소는 비공개 (outbox에 예약 글이 있음)
- 같은 계정 릴스와 카드는 publishAt을 2시간 이상 떨어뜨린다 (Claude가 편집할 때 지킴)
- 발행 끝난 public/media 파일은 한 달에 한 번 지워도 된다 (플랫폼이 발행 때 한 번만 가져감)

## 카드 만드는 도구

`tools/make_cards.py <spec.json>` → `public/media/<folder>/cardNN.jpg` (1080×1350). spec에 `outbox` 칸이 있으면 `outbox/<id>.json`도 만든다. 장 종류·색·장수는 자유 (EDITING-teacher.md 참고). 필요: Python 3, Pillow, 한글 폰트.
