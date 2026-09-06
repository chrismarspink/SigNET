// CLI 시험 — 핵심은 '적합성': 데모(index.html) 코어와 정규화가 바이트 단위로 같아야 한다.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalizeLabel, buildLabel, generateOrgKey, issueCert, verifyLabelSignature,
  unpackHash, packHash } from '../lib/label.mjs';
import { labelToXml, xmlToLabel, computeHash, attachLabel, extractLabelXml,
  FORMATS, capabilities } from '../lib/formats.mjs';
import { writeZip, readZip, entryData, upsertEntry } from '../lib/zipfile.mjs';
import { makeMinimalPdf, attachXmp, extractXmp } from '../lib/pdf.mjs';

let pass = 0, fail = 0;
const check = (n, c, x) => c ? (pass++, console.log('  ok   ' + n))
  : (fail++, console.log('  FAIL ' + n + (x !== undefined ? ' :: ' + JSON.stringify(x) : '')));

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI = path.resolve(import.meta.dirname, '../signet.mjs');
const run = (...a) => execFileSync('node', [CLI, ...a], { encoding: 'utf8', cwd: path.dirname(CLI) });

(async () => {
  /* ══ 1. 적합성: 데모 코어와 정규화 일치 ══ */
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const core = html.split('/*CORE-START*/')[1].split('/*CORE-END*/')[0];
  const mod = { exports: {} };
  new Function('module', 'exports', core)(mod, mod.exports);
  const demo = mod.exports.createSignetCore();
  await demo.init();

  const demoFile = demo.fileById('f3');
  const demoLabel = demoFile.label;
  const demoCanon = demo.canonicalizeLabel(demoLabel);
  const cliCanon = canonicalizeLabel(demoLabel);
  check('데모 라벨에 대한 정규화 결과가 바이트 동일', demoCanon === cliCanon,
    demoCanon === cliCanon ? undefined : { demo: demoCanon.slice(0, 80), cli: cliCanon.slice(0, 80) });

  const root = await generateOrgKey('root', '인증관리과');
  const org = await generateOrgKey('kpost', '정보보안팀');
  const cert = await issueCert(root, org);
  const cliLabel = await buildLabel({ key: org, grade: 'S', basisId: 'PRIV', approver: '김보라 사무관',
    handling: ['NO_REDISTRIBUTION'], hashTarget: 'payload', hashHex: 'c'.repeat(64) });
  check('CLI 라벨에 대한 정규화도 양쪽이 동일', demo.canonicalizeLabel(cliLabel) === canonicalizeLabel(cliLabel));
  check('CLI 라벨을 데모 검증 규약으로 서명 검증',
    await verifyLabelSignature(cliLabel, cert) === true);
  check('정규화에 signature 미포함', !cliCanon.includes(cliLabel.signature?.value ?? 'x'));

  /* ══ 2. 해시 대상 표기 ══ */
  check('해시 대상이 content.hash에 실려 서명으로 보호됨',
    cliLabel.content.hash.startsWith('sha256/payload:') &&
    canonicalizeLabel(cliLabel).includes('sha256/payload:'));
  const up = unpackHash(packHash('text', 'a'.repeat(64)));
  check('해시 대상 파싱', up.target === 'text' && up.hex === 'a'.repeat(64));
  check('구형(접두어 없는) 해시는 whole로 해석', unpackHash('b'.repeat(64)).target === 'whole');

  /* ══ 3. XML 라운드트립 ══ */
  const xml = labelToXml(cliLabel);
  const back = xmlToLabel(xml);
  check('XML 왕복 후 정규화 동일', canonicalizeLabel(back) === canonicalizeLabel(cliLabel),
    canonicalizeLabel(back) === canonicalizeLabel(cliLabel) ? undefined
      : { a: canonicalizeLabel(cliLabel).split('\n'), b: canonicalizeLabel(back).split('\n') });
  check('XML 왕복 후 서명 검증 통과', await verifyLabelSignature(back, cert) === true);
  const esc = await buildLabel({ key: org, grade: 'S', basisId: 'PRIV',
    approver: '<script>&"위험"</script>', hashTarget: 'whole', hashHex: 'd'.repeat(64) });
  check('XML 이스케이프·역이스케이프 왕복',
    xmlToLabel(labelToXml(esc)).approver === '<script>&"위험"</script>');

  /* ══ 4. ZIP 부착 ══ */
  const hwpx = writeZip([
    { name: 'mimetype', data: Buffer.from('application/hwp+zip'), store: true },
    { name: 'Contents/section0.xml', data: Buffer.from('<sec><p>본문</p></sec>') },
    { name: 'docProps/core.xml', data: Buffer.from('<core>작성자</core>') },
  ]);
  const attached = attachLabel(hwpx, 'hwpx', xml);
  check('ZIP 부착 후 라벨 파트 존재',
    readZip(attached).some(e => e.name === 'META-INF/signet-label.xml'));
  check('ZIP 부착 후 mimetype이 첫 엔트리·무압축',
    readZip(attached)[0].name === 'mimetype' && readZip(attached)[0].method === 0);
  check('ZIP 부착이 기존 엔트리를 보존',
    entryData(readZip(attached).find(e => e.name === 'Contents/section0.xml')).toString() === '<sec><p>본문</p></sec>');
  check('ZIP 라벨 추출 = 부착한 XML', extractLabelXml(attached, 'hwpx') === xml);
  check('라벨 재부착 시 중복 생성 없음',
    readZip(attachLabel(attached, 'hwpx', xml)).filter(e => e.name === 'META-INF/signet-label.xml').length === 1);

  /* ══ 5. 해시 대상별 안정성 (자기참조·재저장) ══ */
  const hBefore = await computeHash(hwpx, 'hwpx', 'payload');
  const hAfter = await computeHash(attached, 'hwpx', 'payload');
  check('payload 해시는 라벨 부착에 영향받지 않음 (자기참조 없음)', hBefore === hAfter);
  check('whole 해시는 라벨 부착으로 변한다 (임베디드와 양립 불가)',
    await computeHash(hwpx, 'hwpx', 'whole') !== await computeHash(attached, 'hwpx', 'whole'));
  // 재압축(재저장 시뮬레이션)
  const repacked = writeZip(readZip(attached).reverse().map(e =>
    ({ name: e.name, data: entryData(e), store: e.name === 'mimetype' })));
  check('재압축 후에도 payload 해시 안정',
    await computeHash(attached, 'hwpx', 'payload') === await computeHash(repacked, 'hwpx', 'payload'));
  check('재압축 후 whole 해시는 변경', 
    await computeHash(attached, 'hwpx', 'whole') !== await computeHash(repacked, 'hwpx', 'whole'));
  // 본문 변조는 탐지되어야 한다
  const tampered = upsertEntry(attached, 'Contents/section0.xml', Buffer.from('<sec><p>변조됨</p></sec>'));
  check('본문 변조 시 payload 해시 변경(탐지)',
    await computeHash(attached, 'hwpx', 'payload') !== await computeHash(tampered, 'hwpx', 'payload'));
  // 메타데이터만 바뀌면 text 해시는 안정
  const metaOnly = upsertEntry(attached, 'docProps/core.xml', Buffer.from('<core>다른 작성자</core>'));
  check('메타데이터 변경은 payload(본문 한정)에 영향 없음',
    await computeHash(attached, 'hwpx', 'payload') === await computeHash(metaOnly, 'hwpx', 'payload'));

  /* ══ 6. PDF ══ */
  const pdf = makeMinimalPdf(['line 1', 'line 2']);
  const pdfL = attachLabel(pdf, 'pdf', xml);
  check('PDF 증분 업데이트가 원본 프리픽스를 보존', pdfL.slice(0, pdf.length).equals(pdf));
  check('PDF 라벨 추출 = 부착한 XML', extractLabelXml(pdfL, 'pdf') === xml);
  check('PDF payload 해시는 부착 전후 동일 (자기참조 없음)',
    await computeHash(pdf, 'pdf', 'payload') === await computeHash(pdfL, 'pdf', 'payload'));
  check('PDF whole 해시는 부착으로 변경',
    await computeHash(pdf, 'pdf', 'whole') !== await computeHash(pdfL, 'pdf', 'whole'));
  let refused = false;
  try { attachXmp(Buffer.from('%PDF-1.7\nxref스트림만 있는 문서\nstartxref\n0\n%%EOF'), '<x/>'); }
  catch { refused = true; }
  check('고전 trailer가 없는 PDF는 명시적으로 거부', refused);

  /* ══ 7. 포맷 능력 ══ */
  check('hwp는 임베디드 미지원으로 선언', capabilities('hwp').embed === false);
  check('hwp도 사이드카는 가능', capabilities('hwp').sidecar === true);
  check('hwp 미구현 사유가 계획서 항목을 가리킴', capabilities('hwp').note.includes('R-1'));

  /* ══ 8. CLI 종단 ══ */
  const w = path.join(path.dirname(CLI), 'work', 'test');
  fs.mkdirSync(w, { recursive: true });
  fs.writeFileSync(path.join(w, 'T.hwpx'), hwpx);
  run('keygen', '--keys', 'work/test/keys');
  run('attach', 'work/test/T.hwpx', '--keys', 'work/test/keys', '--grade', 'S', '--basis', 'AUDIT');
  const vout = run('verify', 'work/test/T.hwpx', '--keys', 'work/test/keys');
  check('CLI verify가 유효 판정', vout.includes('유효 (VALID)'), vout.slice(-120));
  fs.writeFileSync(path.join(w, 'T2.hwpx'), upsertEntry(fs.readFileSync(path.join(w, 'T.hwpx')),
    'Contents/section0.xml', Buffer.from('<sec><p>몰래 수정</p></sec>')));
  let code = 0;
  try { run('verify', 'work/test/T2.hwpx', '--keys', 'work/test/keys'); }
  catch (e) { code = e.status; }
  check('CLI verify가 변조본에 종료코드 1', code === 1, code);
  const rt = run('roundtrip', '--before', 'work/test/T.hwpx', '--after', 'work/test/T.hwpx', '--keys', 'work/test/keys');
  check('roundtrip이 동일 파일에 통과 판정', rt.includes('라운드트립 통과'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
