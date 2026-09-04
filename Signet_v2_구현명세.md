# Signet 라벨 체계 v2 — 구현 명세

> **위치**: 『등급라벨_개념정리_시스템설계.pptx』(개념)를 구현 가능한 명세로 옮긴 문서.
> **관계**: 『N2SF_라벨데모_구현스펙.md』(v1 데모)와 『Signet_화면연출_추가지시서.md』를 **확장**한다. v1의 데이터 모델·파이프라인·시나리오는 유지하고, 이 문서가 정의하는 것을 추가·교정한다. 충돌 시 이 문서가 우선한다.
> **범위**: §1~§7은 제품 수준의 논리 명세(구현체 무관), §8은 이를 단일 웹페이지 데모(Signet v1)에 반영하는 델타, §9는 수용 기준.

---

## 0. 핵심 원칙 (v1 대비 변경점 요약)

| # | v1 (기존) | v2 (이 문서) | 근거 |
|---|---|---|---|
| 1 | 라벨 = 등급 + 근거 + 발급자 + 해시 + 서명 + ActionId | **+ 유효기간·폐기권자, 취급조건** (7필드) | 여권 모델은 수명과 폐기 권한이 필요 |
| 2 | 라벨 종류: 내부 / 연합 | **3형 투영: 내부(티켓) / 연합(여권) / 공표(증명서)** | 외부 반출 시 내부 라벨은 내부 정보 그 자체 |
| 3 | O등급이면 그대로 통과 | **관문에서 라벨 변환**: 내부 라벨 제거 → 공표 라벨 발급 | 라벨이 메타데이터 유출 경로가 되지 않도록 |
| 4 | 판정 = 통과 결정 | **판정(관문) ≠ 승인(사람)**: 외부 공표는 승인 워크플로 별도 | 공개는 되돌릴 수 없는 층 |
| 5 | 파일에 임베디드 + 원장 폴백 | **부착 위치 3종**: 객체 임베디드 / 채널·세션 / 사이드카 원장 | 데이터는 파일만이 아니다 |
| 6 | (없음) | **라벨 상속(lineage)**: 파생물은 원본 최고등급 상속, 자동 하향 금지 | 복사·캡처·요약은 같은 정보의 다른 형태 |
| 7 | ZIP은 내부 파일 개별 판정 | **집합 라벨 = 요약본 + 집적 규칙** (조합이 등급을 올릴 수 있음) | 개별 O의 집합이 S가 될 수 있다 |
| 8 | (없음) | **입도 축**: 부분(문단) / 객체 / 집합 | 부분 반출과 집적 위험 |
| 9 | 타 기관 검증 = 판정만 | **검증 이력(도장)을 원장에 누적**, 라벨 재발급 금지 | 여권은 재발급되지 않는다 |
| 10 | U / 유효 / 무효 | **상태기계 5상태**: U → 유효 → 무효 → U(회귀), 유효 → 폐기·만료 | 데이터가 살아있는 한 라벨도 살아있다 |

라벨의 좌표계: **신뢰영역(trust) × 부착위치(attach) × 입도(granularity) × 수명(lifetime)**. 모든 라벨 인스턴스는 이 4축의 값을 가진다.

---

## 1. 데이터 모델

### 1.1 라벨 코어 스키마 (내부 정본)

```json
{
  "schema": "signet/label/2",
  "id": "LBL-2026-0903-0001",
  "grade": "S",                          // C | S | O | U
  "basis": { "law": "정보공개법", "article": "9", "clause": "6", "registryId": "PRIV" },
  "issuer": { "org": "kpost", "unit": "정보보안팀", "keyId": "kpost-sign-2026" },
  "approver": "오주상",                  // O 확정 시 필수
  "actionId": "ACT-2026-0903-0001",
  "issuedAt": "2026-09-03T05:10:00Z",
  "validUntil": "2027-12-31T23:59:59Z",  // null = 정책 기본값 적용
  "revoker": { "type": "owner" | "policy", "ref": "kpost" },
  "handling": ["NO_REDISTRIBUTION", "VIEW_ONLY_EXTERNAL"],   // 취급조건 코드 (기준 레지스트리 정의)
  "granularity": "object",               // portion | object | aggregate
  "attach": "embedded",                  // embedded | channel | sidecar
  "trust": "internal",                   // internal | federated | public
  "content": { "hash": "sha256:a3f9…", "portions": [ { "range": "p3-p5", "grade": "S", "hash": "sha256:…" } ] },
  "lineage": { "parents": ["sha256:…"], "op": "copy" | "capture" | "summarize" | "merge" | "excerpt" | "save-as" | null },
  "signature": { "alg": "ECDSA-P256", "over": "canonical(core)", "value": "base64…" }
}
```

**정규화(canonical)**: `id, grade, basis.*, issuer.*, approver, actionId, issuedAt, validUntil, revoker.*, handling(정렬), granularity, attach, trust, content.hash, content.portions(정렬), lineage.parents(정렬), lineage.op`를 고정 순서로 직렬화한 UTF-8. 발급·검증이 **동일 함수** `canonicalize(label)`를 사용한다. `signature`는 정규화 대상에서 제외.

### 1.2 3형 투영 (trust 축)

라벨은 하나의 코어에서 신뢰영역별로 **투영(projection)** 된다. 바깥으로 갈수록 필드가 줄어든다.

| 필드 | internal (티켓) | federated (여권) | public (증명서) |
|---|---|---|---|
| grade | 그대로 | 발급기관 등급값 + basis (수신측 번역) | **없음** |
| basis | 그대로 | 그대로 (번역 열쇠) | 없음 |
| issuer + signature | 기관 키 (HMAC 허용) | 기관 인증서 + 국가 루트 체인 (전자서명 필수) | 기관 인증서 + 전자서명 |
| content.hash | 있음 | 있음 | **있음 (내부와의 유일한 연결)** |
| approver, unit, actionId | 있음 | **없음** (원장에만) | 없음 |
| validUntil, revoker | 선택 | **필수** | issuedAt만 |
| handling | 내부 정책 코드 | 협약 코드 | 없음 또는 공개 라이선스 코드 |
| lineage | 있음 | parents 해시만 | 없음 |
| verify | ECM 원장 직접 | 발급기관 원장 프로토콜 / 오프라인 서명 | `verifyUrl` / 오프라인 서명 |
| granularity | portion/object/aggregate | object/aggregate | object |

`project(label, trust) → label'` 함수는 **필드 삭제만** 하며 값 변경은 하지 않는다(단, public은 grade·basis 자체를 제거). 투영 결과는 **재서명**된다 — 투영은 새 서명 대상이다.

### 1.3 원장 (Ledger) 레코드

인스턴스 원장은 append-only. 레코드 종류(`kind`) 6가지:

```json
{ "seq": 10412, "kind": "issue",   "hash": "sha256:…", "labelId": "LBL-…", "label": { …core… }, "at": "…" }
{ "seq": 10413, "kind": "stamp",   "hash": "sha256:…", "verifier": "police", "result": "pass", "translated": "O", "at": "…" }
{ "seq": 10414, "kind": "invalid", "hash": "sha256:…", "reason": "hash-mismatch" | "sig-mismatch" | "key-revoked", "at": "…" }
{ "seq": 10415, "kind": "reclass", "hash": "sha256:…", "prevLabelId": "LBL-…", "newLabelId": "LBL-…", "by": "owner|delegate", "at": "…" }
{ "seq": 10416, "kind": "relabel", "hash": "sha256:…", "from": "internal", "to": "public", "approvalId": "APR-…", "publicLabelId": "LBL-…", "at": "…" }
{ "seq": 10417, "kind": "retire",  "hash": "sha256:…", "cause": "expired" | "owner-revoked", "at": "…" }
```

- 조회 키는 항상 `hash` (콘텐츠 SHA-256). 파일명·라벨ID는 보조 인덱스.
- `stamp`는 **수신 기관의 검증 기록**이다. 발급기관 원장에 기록하는 것을 정본으로 하고(발급자가 라벨의 주인), 수신기관은 자기 원장에 사본 기록 가능. 두 원장의 동기화는 §7 남는 질문.
- `lineage`는 레코드의 `label.lineage.parents`로 표현되며, 원장은 이를 그래프로 질의할 수 있어야 한다: `descendants(hash)`, `ancestors(hash)`.

### 1.4 기준 레지스트리 (Criteria Registry) 확장

```json
{
  "categories": [ { "id": "PRIV", "basis": "정보공개법 §9-6", "grade": "S", "controls": ["N2SF-IF-14", "N2SF-DU-2"] }, … ],
  "handlingCodes": [ { "code": "NO_REDISTRIBUTION", "desc": "재배포 금지" }, … ],
  "aggregationRules": [
    { "id": "AGG-PII-1", "when": { "allOf": ["NAME", "ADDRESS", "BIRTHDATE"] }, "then": { "grade": "S", "basis": "PRIV" } }
  ],
  "defaults": { "validityDays": 730, "unlabeledGrade": "U" },
  "signature": { "signer": "root", "value": "…" }
}
```

`aggregationRules`는 §3.3 집합 판정에서 사용. 표현 문법은 `allOf / anyOf / count>=n` 세 연산자로 한정한다(1차).

### 1.5 등가 협약 (Equivalence Agreement)

```json
{
  "verifier": "kpost", "issuer": "ndata",
  "gradeMap": { "공개": "O", "민감": "S", "기밀": "C" },
  "basisMap": { "*": "same" },                 // 근거 조항은 법령 공통이므로 기본 동일
  "handlingMap": { "재배포금지": "NO_REDISTRIBUTION" },
  "validUntil": "2027-06-30", "signature": { "signer": "root", "value": "…" }
}
```

협약 부재 = `gradeMap` 조회 실패 → 등급 해석 불가 → **U 강등** (서명이 유효해도).

---

## 2. 부착 위치 (attach 축)

| attach | 대상 | 구현 |
|---|---|---|
| `embedded` | 파일 | HWP: CFB 커스텀 스트림 `Signet/Label` / HWPX·OOXML: `META-INF/signet-label.xml` 또는 `customXml/signetLabel.xml` / PDF: XMP `signet:` 네임스페이스 / 이미지: XMP·iTXt (보조) |
| `channel` | 클립보드, RBI 세션, API 연결, LLM 프롬프트 요청 | 세션 객체에 `sessionLabel` 부착. 세션 라벨은 **채널 양 끝 에이전트**가 생성·검증. 저장(정착) 시 embedded 또는 sidecar로 전환 |
| `sidecar` | 모든 것 (특히 텍스트·이미지·음성) | 원장 레코드 자체. 게이트는 `hash → lookup` |

**세션 라벨 스키마**:
```json
{ "sessionId": "…", "sourceHash": "sha256:…", "inheritedGrade": "S", "sourceLabelId": "LBL-…",
  "channel": "clipboard" | "rbi" | "api" | "prompt", "createdAt": "…", "ttlSec": 600, "signature": "…" }
```
세션 라벨은 짧게 산다(`ttl`). 채널을 벗어나 정착하는 순간(붙이기 후 저장, 캡처 파일 생성) 상속 엔진(§4)이 **객체 라벨 발급 또는 원장 등록**으로 전환한다.

**채널별 집행 지점**:

| 채널 | 등급 결정 | 집행 지점 | 차단 조건 |
|---|---|---|---|
| clipboard | 복사 원본 라벨 상속 | 붙이기 대상 앱/망 에이전트 | 대상 trust < 원본 grade 요구 (예: S 조각을 O망 앱에 붙이기) |
| rbi | 표시 중 문서 등급 | RBI 서버 (워터마크 = 픽셀용 라벨), 캡처 감지 에이전트 | 캡처물은 파생물로 원장 등록(lineage.op=capture) |
| prompt (모델 2) | 요청 내 조각별 최고등급 | AI Filter | 비O 조각 포함 시 요청 차단 |
| api | 소스 시스템 등급 | 양 끝 게이트웨이 | 세션 라벨 협상 실패 시 연결 거부 |
| db | 컬럼 라벨 최고등급 + 집적 규칙 | DB 프록시 | 결과 집합이 규칙에 걸리면 상향 후 판정 |
| audio/video | 컨테이너 메타 + 원장(주), STT 콘텐츠 검사(보조) | 관문(AI Filter) | 검사 결과 비O |

---

## 3. 관문 판정 파이프라인 (8단계)

`gate(input, verifierOrg, target) → Verdict` — 입력은 파일·세션·묶음 중 하나. **판정(verdict), 귀속(attribution), 변환(relabel)은 별도 출력 필드**.

```
1. extract     : embedded → channel(session) → none
2. verify      : chain(issuer→root) ∧ sig(canonical) ∧ hash(content == label.content.hash) ∧ notExpired(validUntil)
3. fallback    : (1 없음 ∨ 2 실패) → ledger.lookup(hash) → attribution = 이력(등급·근거·승인자·시각) / verdict.grade = U 유지
4. grade       : 동일기관 → criteria 대조 / 타기관 → agreement(verifier, issuer) 존재? → gradeMap 번역 / 부재 → U
5. aggregate   : 입력이 묶음이면 풀어 개별 1~4 수행 → max(grade) → aggregationRules 적용(상향 가능) / portion이면 반출 범위를 portion 단위로 절단
6. verdict     : effectiveGrade == O → PASS_CANDIDATE, else BLOCK
7. approval    : target.trust == public ∧ PASS_CANDIDATE → approvalRequired=true → 승인 워크플로 대기 (승인 없으면 HOLD)
8. relabel     : PASS 확정 ∧ target.trust != internal → project(label, target.trust) → 재서명 → 내부 라벨 제거 → ledger.append(kind=relabel)
```

출력:
```json
{ "verdict": "PASS" | "BLOCK" | "HOLD", "effectiveGrade": "O", "translatedFrom": "공개",
  "attribution": { "found": true, "grade": "S", "basis": "PRIV", "approver": "…", "issuedAt": "…" } | null,
  "reasons": ["sig-mismatch"], "relabeled": { "to": "public", "labelId": "LBL-…" } | null,
  "stamp": { "written": true, "seq": 10413 } }
```

불변식:
- 3(귀속)은 verdict를 바꾸지 않는다.
- 7(승인)은 6(판정)을 대체하지 않는다 — BLOCK은 승인으로 뒤집을 수 없다.
- 8(변환)은 PASS 확정 후에만 실행되며, **내부 필드(approver, unit, actionId, basis, grade)가 산출물에 남으면 실패로 처리**한다(자체 검사).
- 타 기관 검증 성공 시 `stamp` 레코드를 발급기관 원장에 기록한다. 라벨 자체는 수정하지 않는다.

---

## 4. 상속 엔진 (Lineage)

**포착 지점과 op**: 복사(`copy`, 클립보드 에이전트) / 캡처(`capture`, 화면 에이전트) / 다른 이름 저장(`save-as`, ECM) / 요약·번역(`summarize`, AI Filter) / 묶음(`merge`, 압축·첨부) / 발췌(`excerpt`).

**전파 규칙** `propagate(parents[], op) → draftLabel`:

| 상황 | 규칙 |
|---|---|
| 단일 원본 → 파생 | grade 상속, basis 상속, lineage.parents=[원본] |
| 다중 원본 → merge | max(grade) + aggregationRules 적용 (상향 가능) |
| excerpt | 발췌 범위에 portion 라벨이 있으면 그 grade, 없으면 문서 grade |
| summarize / translate | 상속 + `pendingReview=true` ("S?") → 사람 확정 전 **하향 금지** |
| reclass (재분류) | 오너 또는 협약 위임 범위 내에서만 → 새 label + ledger `reclass`, 구 라벨 `invalid` |
| 하향 (→O) | **사람 승인 필수**. 자동 하향 경로 없음 |

**오너십**: lineage 루트의 issuer가 오너. 파생 노드의 관리자(custodian)는 바뀔 수 있으나 오너는 불변. `revoker.type=owner`는 루트 오너를 가리킨다.

**질의**: `descendants(hash)` — 유출 영향 범위 / `ancestors(hash)` — 귀속 경로.

---

## 5. 라이프사이클 상태기계

상태: `U`(미분류) · `VALID` · `INVALID` · `RETIRED`(폐기·만료)

| 전이 | 트리거 | 주체 | 원장 |
|---|---|---|---|
| U → VALID | 분류·서명·발급 | 기관 (사람 확정) | `issue` |
| VALID → VALID | 타 기관 검증 성공 | 수신 기관 | `stamp` |
| VALID → INVALID | hash 불일치 / sig 불일치 / key 폐기 | 관문 자동 | `invalid` |
| INVALID → U | 자동 회귀 | 시스템 | (상태 전이 기록) |
| VALID → VALID' | 재분류 | 오너/위임 | `reclass` |
| VALID → RETIRED | validUntil 도달 / 오너 폐기 | 정책 또는 오너 | `retire` (삭제 아님) |

`RETIRED` 라벨은 관문에서 U와 동일 취급(차단)하되 attribution은 "만료됨"으로 표시.

---

## 6. 컴포넌트와 인터페이스

| 컴포넌트 | 책임 | 주요 함수 |
|---|---|---|
| Label Service | 발급·투영·재서명 | `issue(content, grade, basis, approver) → label`, `project(label, trust)`, `canonicalize`, `sign/verify` |
| Ledger | append-only 원장 + 그래프 질의 | `append(rec)`, `lookup(hash)`, `history(hash)`, `descendants`, `ancestors`, `checkpoint()`(일별 앵커) |
| Criteria Registry | 기준·취급코드·집적규칙 (서명본) | `category(id)`, `aggregation(items[])`, `verifySelf()` |
| Federation | 체인·협약 | `chain(issuerCert) → bool`, `agreement(verifier, issuer) → map|null`, `translate(grade, map)` |
| Gate | §3 파이프라인 | `gate(input, verifier, target) → Verdict` |
| Lineage Engine | §4 | `capture(op, parents[], payload) → draftLabel`, `propagate` |
| Channel Agents | 세션 라벨 | `onCopy/onPaste`, `onCapture`, `onPromptSubmit`, `onApiConnect` |
| Relabel | §3-8 | `relabel(label, target) → publicLabel` + 내부 필드 잔존 자체 검사 |
| Approval Workflow | 반출 승인 | `request(hash, target) → APR-id`, `decide(APR-id, approver, yes/no)` |
| External Verifier | 공표 라벨 검증 | `verifyOffline(publicLabel, issuerCert)`, `verifyUrl(hash) → {authentic, issuedAt}` (등급·근거 노출 금지) |

---

## 7. 열린 질문 (구현 시 결정 필요)

1. `aggregationRules` 문법 확장 여부 (1차는 allOf/anyOf/count).
2. 문단(portion) 라벨의 HWP/HWPX 임베딩 — 커스텀 스트림은 문서 단위. 본문 XML 마크 필요, 편집기 호환성 검증 선행.
3. 클립보드 에이전트와 기존 DLP(소만사)의 역할 분담 — 상속 정보를 DLP에 전달하는 인터페이스가 답일 가능성.
4. `pendingReview`(S?) 확정 부담 — 모델 2에서 매 프롬프트마다 필요하면 실용성 문제. 규칙 기반 자동 확정 범위 정의.
5. `stamp` 저장 위치 — 발급기관 원장(정본) vs 수신기관 원장 사본, 동기화 방식.
6. `verifyUrl` 노출 범위 — 진본 여부만 vs 발행일 포함. 공개 범위 정책.

---

## 8. Signet v1 데모 반영 델타

v1 데모(단일 HTML, WebCrypto 실연산)에 다음을 추가한다. **기존 6개 시나리오·4개 조직·폴더 이동 모델·레지스트리 뷰어는 유지**.

### 8.1 데이터 모델 변경
- 라벨 객체에 `validUntil`, `revoker`, `handling[]`, `granularity`, `attach`, `trust`, `lineage` 추가. 정규화 함수 갱신(구 라벨 전부 재서명 — 로드 시 생성이므로 자동).
- 인스턴스 원장 레코드에 `kind` 필드 도입 (`issue|stamp|invalid|reclass|relabel|retire`). 뷰어에 kind별 색 배지.
- 기준 레지스트리에 `handlingCodes`, `aggregationRules`(AGG-PII-1: 이름+주소+생일 → S) 추가.

### 8.2 새 데이터 객체
- **세션 객체**(클립보드): `{ sessionId, sourceHash, inheritedGrade, channel:"clipboard", ttlSec }`. 화면 우측 상단에 "클립보드" 소형 패널 — 현재 세션 라벨을 스탬프로 표시.
- **묶음 파일** 1개 추가: `인사_기초자료.zip` = 3개 파일(이름목록 O, 주소목록 O, 생년월일목록 O). X-ray는 ZIP 엔트리 트리 + 각 내부 파일의 개별 스탬프.
- **만료 라벨 파일** 1개 추가: `2024_보도자료.hwp` — `validUntil` 과거.

### 8.3 폴더 구성 변경
- Stage 1: `📁 업무망` → 관문 → `📁 외부 반출함`에 **`📁 승인 대기함`** 추가 (HOLD 상태 파일이 머무는 곳). 승인 대기함의 파일에 `[승인]` 버튼 → 승인자 이름 입력 → PASS → 라벨 변환 애니메이션(내부 스탬프가 떼어지고 파란 "진본 증명" 스탬프가 찍힘) → 외부 반출함 이동.
- 관문 콘솔 파이프라인을 **8단계**로 확장(§3). 3(폴백)·7(승인)·8(변환) 라인은 각각 S/C/BLUE 색.

### 8.4 X-ray 뷰 변경
- 라벨 카드에 새 필드 표시(유효기간·폐기권자·취급조건·입도·부착·신뢰영역·lineage.parents).
- **공표 라벨 카드**는 별도 스타일(파란 테두리, 필드 5개만: 발행기관·발행일·해시·서명·검증URL). 카드 하단에 "내부 필드 없음 ✓" 자체 검사 표시.
- 조작 버튼 추가: `[복사]`(선택 문단을 클립보드 세션으로 — 세션 패널에 상속 스탬프 등장), `[유효기간 만료시키기]`.

### 8.5 신규 시나리오 (7~10)

7. **클립보드 상속**: `2026_사업계획_초안.hwpx`(S)에서 문단 [복사] → 클립보드 패널에 S 스탬프(상속) → 새 파일 `메모.txt`(U)에 [붙이기] → 상속 엔진이 `메모.txt`에 S 라벨 자동 초안 발급(lineage.op=copy, parents=[원본 해시]) → 원장에 `issue` 레코드 + parents 표시 → 외부 이동 시도 → BLOCK. *메시지: 파일이 아닌 데이터도 등급을 들고 다닌다. 복사한 문단은 원본을 상속한다.*
8. **집적 위험**: `인사_기초자료.zip` — 내부 3파일 모두 O → 이동 시도 → 관문 5단계에서 묶음 해제 → 개별 O 확인 → `AGG-PII-1` 규칙 매치 → 집합 등급 S로 상향 → BLOCK. 콘솔에 "이름+주소+생년월일 = 개인정보 (규칙 AGG-PII-1)" 표시, 기준 레지스트리 탭의 규칙 행 하이라이트. *메시지: 각각 O여도 모이면 S. 컨테이너 라벨은 개별 라벨의 대체가 아니다.*
9. **라벨 변환과 승인**: `공개_통계요약.pdf`(O) → 외부 이동 시도 → 1~6 PASS_CANDIDATE → 7단계 `target=public` → HOLD → 승인 대기함 이동 → [승인] → 8단계 라벨 변환: X-ray에서 내부 라벨 카드(근거·승인자·ActionId 포함)가 떼어지고 공표 라벨 카드(5필드)로 교체, "내부 필드 없음 ✓" → 외부 반출함 안착 → 원장에 `relabel` 레코드. *메시지: 판정과 승인은 다르다. 국경에서 라벨은 바뀐다 — 내부 정보는 라벨을 타고 나가지 않는다.*
10. **만료**: `2024_보도자료.hwp`(O, validUntil 과거) → 이동 시도 → 2단계 `notExpired` 실패 → 폴백 조회 → 귀속 "2024-03 발급, 2026-03 만료" → BLOCK(RETIRED 취급) → 콘솔에 "재분류 필요: 오너(우정사업본부)만 갱신 가능". *메시지: 데이터가 살아있는 한 라벨도 살아있고, 끝내는 것은 정책 또는 오너다.*

### 8.6 여권 스테이지 보강
- 시나리오 5(타 기관 라벨 인정) PASS 시 원장에 `stamp` 레코드(verifier=kpost, translated="공개→O")가 **국가데이터청 원장 섹션**에 기록되는 것을 표시 — 원장 뷰어를 조직별 섹션으로 나눈다("발급기관 원장이 정본").
- 라벨 카드는 변경되지 않음을 강조: "재발급 아님 — 도장만 누적".

### 8.7 해설 밴드 추가 문구 (1문장씩, 슬로건 금지 — 기능 서술만)
- Stage 1: "관문은 판정하고, 사람이 승인하며, 통과가 확정된 뒤 라벨이 외부용으로 바뀝니다."
- Stage 2: "타 기관의 라벨은 바뀌지 않습니다. 검증 결과만 발급기관 원장에 기록됩니다."

---

## 9. 수용 기준

**논리 명세(§1~6)**
- [ ] `canonicalize`가 발급·검증에서 동일 함수이며 signature 제외 전 필드를 포함
- [ ] `project(label, "public")` 결과에 grade/basis/approver/unit/actionId/lineage가 존재하지 않음 (자체 검사 함수가 실패를 반환)
- [ ] 협약 부재 시 체인·서명 유효라도 effectiveGrade=U
- [ ] `aggregation([O,O,O])`가 AGG-PII-1 매치 시 S 반환
- [ ] `propagate([S], "copy")`=S, `propagate([O,S], "merge")`=S, `propagate([S], "summarize")`=S+pendingReview, 자동 하향 경로 없음
- [ ] 상태기계: INVALID는 항상 U로만 회귀, RETIRED는 관문에서 차단 + "만료" 귀속
- [ ] 타 기관 검증 성공 시 라벨 불변, 원장에 `stamp` append

**데모 델타(§8)**
- [ ] 시나리오 7~10이 각각 1클릭 자동 재생되고 리셋이 완전함 (클립보드 세션·승인 대기함 포함)
- [ ] 라벨 변환 후 X-ray의 공표 라벨 카드에 내부 필드가 없고 "내부 필드 없음 ✓"가 실검사 결과로 표시
- [ ] 집적 시나리오에서 기준 레지스트리의 AGG-PII-1 행이 하이라이트되고 콘솔에 규칙 ID가 출력
- [ ] 클립보드 세션 라벨이 붙이기 후 객체 라벨로 전환되며 원장 레코드에 parents 해시가 표시
- [ ] 원장 뷰어가 kind별 배지와 조직별 섹션을 가짐
- [ ] 기존 v1 수용 기준 전부 유지 (실연산·스킵·DEMO 배지·슬로건 없음 등)

---

## 10. v2.1 보정 — 협약 불가 영역(단순 외부 반출) 반영

> 클로드 코드의 「협약 불가 영역 — 단순 외부 반출 정책」 검토 결과를 대조하여 도출한 보정. **이 절은 §1~§8의 해당 항목을 덮어쓴다.**

### 10.1 라벨 코어에 배포 범위 필드 추가 (§1.1 수정)

```json
"releasableTo": { "scope": "internal" | "federated" | "unrestricted",
                  "orgs": ["police", "kexim"],            // scope=federated 시 허용 기관 (협약 필수)
                  "conditions": ["SANITIZED", "WATERMARKED"] }
```
- 기밀성 등급(`grade`)과 배포 범위(`releasableTo`)는 **직교**한다. S 문서도 `federated:[police]`로 이동 가능하고, O 문서도 `internal`로 묶일 수 있다(내부 공개 ≠ 대외 공개).
- 정규화 대상에 포함. `project(label, "public")`은 이 필드도 제거.
- 기본값: 미지정 시 `internal`.

### 10.2 파이프라인 6단계 교정 (§3 수정)

```
6. verdict : target ∈ releasableTo.scope
             ∧ (target.trust == "federated" → agreement(verifier, issuer).allows(effectiveGrade) ∧ target.org ∈ releasableTo.orgs)
             ∧ (target.trust == "public"    → effectiveGrade == O ∧ releasableTo.scope == "unrestricted")
             → PASS_CANDIDATE, else BLOCK
```
"O만 통과"는 public 대상에만 남는 특수 규칙이다. 등가 협약(§1.5)에 `allowedGrades: ["O","S"]`를 추가한다.

### 10.3 승인 레코드에 수신자·목적 추가 (§6 Approval Workflow 수정)

```json
{ "id": "APR-2026-…", "hash": "sha256:…", "target": { "trust": "public", "recipient": "○○일보 김기자 <a@b.c>", "channel": "mail-gateway" },
  "purpose": "보도자료 배포", "requester": "…", "approver": "…", "decidedAt": "…", "decision": "approve" | "reject" }
```
`request(hash, target, recipient, purpose)`. 승인 없는 public 반출 경로는 존재하지 않는다. federated 반출은 협약이 승인을 대체한다(정책 결정 사항 — 협약별로 `requiresApproval` 플래그 허용).

### 10.4 8단계를 "위생처리 → 재해시 → 치환 → 재서명"으로 확장 (§3-8 수정)

```
8a. sanitize : 포맷별 위생처리 → 산출물 bytes'
8b. rehash   : postHash = sha256(bytes')
8c. relabel  : publicLabel = project(label, target.trust) + { content.hash: postHash, releaseId: opaque(APR-id, recipient) } → 재서명
8d. ledger   : append(kind="relabel", preHash, postHash, releaseId, approvalId, sanitizeReport)
8e. lineage  : postHash의 lineage.parents=[preHash], op="release"
```
**공개 검증 창구는 postHash로 조회**된다. preHash↔postHash 연결은 원장 내부에만 존재한다.

**포맷별 위생처리 항목 (1차 목록)**

| 포맷 | 제거 대상 |
|---|---|
| HWP (CFB) | `PrvText`(미리보기 텍스트), `PrvImage`, `DocInfo` 내 작성자/변경이력, 숨은 문단, 메모, 내부 라벨 스트림 |
| HWPX / OOXML | `docProps/core.xml`·`app.xml` 작성자·수정자·회사, 변경 추적(`w:ins/w:del`), 코멘트, 숨은 텍스트·숨은 셀·숨은 시트, 사용자 정의 XML 파트, 내부 라벨 파트 |
| PDF | Info 사전·XMP 작성자, 첨부, 주석, 증분 업데이트 이전 버전, 내부 라벨 XMP |
| 이미지 | EXIF/XMP 전체 (GPS, 기기), 썸네일 |

`sanitizeReport`는 제거 항목 목록이며 원장에 남긴다(감사용). 위생처리 실패 시 반출 중단.

### 10.5 공표 라벨에 불투명 반출 식별자 추가 (§1.2 public 열 수정)

`releaseId`: 승인 ID + 수신자를 키 유도한 불투명 값. 수신자별로 다르며, 원장에서만 수신자로 역해석된다. 수신자별 워터마크(가시/비가시)를 적용한 경우 워터마크 해시도 `relabel` 레코드에 기록 → 유출본 발견 시 `releaseId` 또는 워터마크로 수신자 귀속.

### 10.6 채널 표에 메일·메신저 추가 (§2 수정)

| 채널 | 등급 결정 | 집행 지점 | 정책 |
|---|---|---|---|
| mail (지정 채널) | 첨부 해시 → 원장 조회 (라벨 유무 무관) | DLP 연동 메일 게이트웨이 | 승인된 `releaseId` 첨부만 통과. 라벨 박리 첨부는 폴백 조회로 원 분류 복원 → 차단 |
| messenger / 웹 업로드 (비지정) | 동일 | 엔드포인트 DLP / 프록시 | **원칙 차단**. 탐지 시 해시 조회 → 귀속 기록 |

외부 반출의 3중 구조: **지정 채널로 몰기 → 비지정 채널 탐지·차단 → 유출 시 귀속(해시·releaseId·워터마크)**. 마지막 층은 기존 시나리오 4(라벨 박리 → 원장 귀속)의 논리를 외부 채널에 적용한 것이다.

### 10.7 데모 델타 수정 (§8 수정)

- **Stage 3 · 공표(외부 반출) 신설.** §8.5의 시나리오 9(라벨 변환·승인)를 Stage 1에서 Stage 3으로 이동. 폴더 구성: `📁 업무망` → 관문 → `📁 승인 대기함` → `📁 외부 (협약 없는 수신자)`.
- 시나리오 9 확장: 이동 시도 시 **반출 승인 폼**(수신자 식별·목적·승인자) → HOLD → 승인 → 콘솔에 `8a sanitize` 로그(X-ray의 `PrvText`·`docProps/core.xml` 노드가 제거 애니메이션) → `8b rehash`(해시값이 바뀌는 것을 표시) → `8c relabel`(공표 라벨 카드, `releaseId` 포함) → 외부 폴더 안착 → **공개 검증 창구 패널**에서 postHash 조회 → "우정사업본부 2026-09-03 공개 배포 진본 ✓" (등급·근거 미표시).
- 시나리오 11 (신규) **비지정 채널 유출 귀속**: `📁 메신저(비지정)`로 라벨 박리된 S 파일 드래그 → 엔드포인트 에이전트가 해시 조회 → 원 분류 S·발급자·승인자 귀속 → 차단 + 감사 토스트. *메시지: 메신저에는 게이트가 없지만 해시는 남는다.*
- 시나리오 5(여권) 보강: 대상 파일을 **S 등급**(예: `민원_이관자료.hwpx`, `releasableTo: federated:[ndata]`)으로 교체하여 협약이 S 이동을 허용하는 장면을 보임. 국가데이터청의 협약에 `allowedGrades:["공개","민감"]`. 협약 미체결 기관(kari)은 등급 무관 차단.
- 라벨 카드에 `releasableTo` 표시(스탬프 아래 소형 리본: "내부" / "협약기관: …" / "무제한").

### 10.8 수용 기준 추가 (§9 추가)

- [ ] `releasableTo`가 정규화·서명 대상에 포함되고, public 투영에서 제거됨
- [ ] S 라벨 + `federated:[ndata]` + 협약 `allowedGrades` 포함 시 PASS, 협약 미포함 등급이면 BLOCK, 협약 미체결 기관이면 등급 무관 BLOCK
- [ ] public 반출은 승인 레코드(수신자·목적·승인자) 없이 실행 경로가 존재하지 않음
- [ ] 8단계 산출물의 해시가 원본과 다르고, 공표 라벨은 postHash를 담으며, 원장 `relabel` 레코드가 preHash·postHash·sanitizeReport를 가짐
- [ ] 공개 검증 창구가 postHash로 진본·발행일만 반환하고 등급·근거·승인자를 반환하지 않음
- [ ] 비지정 채널로 이동한 라벨 박리 파일이 해시 조회로 귀속·차단됨
