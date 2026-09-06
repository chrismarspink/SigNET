# Signet CLI

실파일에 Signet 라벨을 부착·검증하고, 편집기 재저장 보존성을 측정하는 도구.
`../Signet_부착보존성_실측계획서.md`의 절차를 실행하기 위해 만들었다.

의존성 없음 (Node 20+ 내장 모듈만 사용). ZIP·PDF 처리와 암호 연산 모두 자체 구현/내장 WebCrypto.

## 빠른 시작

```bash
node signet.mjs keygen                 # 키·간이 인증서
node signet.mjs specimen               # 측정 시료 생성
node signet.mjs attach work/specimen/S-01_사업계획_초안.hwpx --grade S --basis AUDIT
node signet.mjs verify work/specimen/S-01_사업계획_초안.hwpx
node signet.mjs extract work/specimen/S-01_사업계획_초안.hwpx
node signet.mjs roundtrip --before 원본 --after 재저장본
node signet.mjs caps                   # 포맷별 부착·해시 능력
```

## 데모와의 관계

라벨 스키마와 **정규화 규칙은 `../index.html`의 코어와 동일**하다. 두 구현이 갈라지면
서명 호환성이 깨지므로, `test/run.mjs`가 데모 코어를 직접 읽어 정규화 결과가 바이트 단위로
같은지 강제한다.

```bash
node test/run.mjs      # 적합성 포함 32건
```

## 해시 대상

파일 안에 라벨을 넣으면서 파일 전체를 해시할 수는 없다(자기참조). 그래서 부착 대상을
해시에서 제외하고, 무엇을 해시했는지를 값에 실어 서명으로 보호한다 — `sha256/payload:<hex>`.

| 대상 | 의미 | 지원 |
|---|---|---|
| `whole` | 파일 전체 바이트 | 전 포맷 (사이드카 부착에만 실용적) |
| `payload` | 본문 파트만 (ZIP: 본문 엔트리 / PDF: 첫 `%%EOF`까지) | hwpx·docx·pdf |
| `text` | 본문 텍스트를 공백 정규화 | hwpx·docx |

## 한계

- **HWP(CFB) 쓰기 미구현** — 사이드카로만 부착. 계획서 R-1.
- PDF는 고전 xref만 지원. xref 스트림 문서는 명시적으로 거부한다.
- 시험용 키는 평문 JSON. 운영은 GPKI 인증서 + HSM/KMS.
