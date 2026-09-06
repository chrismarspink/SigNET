// 최소 ZIP 리더/라이터 — 외부 의존 없이 node:zlib만 사용.
// HWPX/ODF 계열의 'mimetype 최초·무압축' 규칙을 보존한다.
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const EOCD_SIG = 0x06054b50, CEN_SIG = 0x02014b50, LOC_SIG = 0x04034b50;

export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP EOCD를 찾을 수 없음 (ZIP 파일이 아니거나 손상)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff) throw new Error('ZIP64는 미지원 (측정 대상 외)');
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== CEN_SIG) throw new Error('중앙 디렉터리 시그니처 불일치');
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nlen).toString('utf8');
    // 로컬 헤더에서 실제 데이터 시작 위치를 다시 계산한다 (extra 길이가 다를 수 있음)
    if (buf.readUInt32LE(lho) !== LOC_SIG) throw new Error(`로컬 헤더 불일치: ${name}`);
    const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28);
    const dstart = lho + 30 + lnlen + lelen;
    const raw = buf.slice(dstart, dstart + csize);
    entries.push({ name, method, crc, csize, usize, raw });
    off += 46 + nlen + elen + clen;
  }
  return entries;
}

export function entryData(e) {
  if (e.method === 0) return e.raw;
  if (e.method === 8) return zlib.inflateRawSync(e.raw);
  throw new Error(`미지원 압축 방식 ${e.method}: ${e.name}`);
}

// entries: [{name, data, store?}] — store=true면 무압축(mimetype 규칙)
export function writeZip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data;
    const store = !!e.store;
    const comp = store ? data : zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(LOC_SIG, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0, 6);             // flags (UTF-8 비트는 쓰지 않음: ASCII 경로만 사용)
    lh.writeUInt16LE(store ? 0 : 8, 8); // method
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);  // time/date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(CEN_SIG, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(store ? 0 : 8, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

// 라벨 파트를 넣거나 교체한다. mimetype은 항상 첫 엔트리·무압축으로 유지.
export function upsertEntry(buf, name, data) {
  const src = readZip(buf);
  const out = [];
  let replaced = false;
  for (const e of src) {
    if (e.name === name) { out.push({ name, data, store: false }); replaced = true; }
    else out.push({ name: e.name, data: entryData(e), store: e.name === 'mimetype' });
  }
  if (!replaced) out.push({ name, data, store: false });
  const mi = out.findIndex(e => e.name === 'mimetype');
  if (mi > 0) out.unshift(out.splice(mi, 1)[0]);
  return writeZip(out);
}
