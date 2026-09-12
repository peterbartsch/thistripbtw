/* The EXIF reader is pure arithmetic over bytes, so it can be tested without a browser —
   which is the whole point of preferring a calculation you can check (CLAUDE.md). */
import { readFileSync, writeFileSync } from "node:fs";

// Build a JPEG whose EXIF says Emerald Bay, Lake Tahoe: 38°57'20.4"N 120°06'36.0"W
function jpegWithGps(latDMS, ns, lngDMS, ew, {little=false}={}) {
  const rat = (n, d) => { const b = Buffer.alloc(8);
    if (little) { b.writeUInt32LE(n,0); b.writeUInt32LE(d,4); } else { b.writeUInt32BE(n,0); b.writeUInt32BE(d,4); } return b; };
  const gpsEntries = [
    { tag:0x0001, type:2, count:2, val: Buffer.from(ns+"\0") },
    { tag:0x0002, type:5, count:3, off:true, data: Buffer.concat(latDMS.map(([n,d])=>rat(n,d))) },
    { tag:0x0003, type:2, count:2, val: Buffer.from(ew+"\0") },
    { tag:0x0004, type:5, count:3, off:true, data: Buffer.concat(lngDMS.map(([n,d])=>rat(n,d))) },
  ];
  const w16=(b,o,v)=> little? b.writeUInt16LE(v,o) : b.writeUInt16BE(v,o);
  const w32=(b,o,v)=> little? b.writeUInt32LE(v,o) : b.writeUInt32BE(v,o);
  // TIFF: header(8) + IFD0(1 entry -> GPS ptr) + GPS IFD + data
  const ifd0Off = 8;
  const ifd0 = Buffer.alloc(2 + 12 + 4);
  const gpsOff = ifd0Off + ifd0.length;
  const gpsIFD = Buffer.alloc(2 + 12*gpsEntries.length + 4);
  let dataOff = gpsOff + gpsIFD.length;
  const blobs=[];
  w16(ifd0,0,1); w16(ifd0,2,0x8825); w16(ifd0,4,4); w32(ifd0,6,1); w32(ifd0,10,gpsOff);
  w16(gpsIFD,0,gpsEntries.length);
  gpsEntries.forEach((e,i)=>{ const o=2+i*12;
    w16(gpsIFD,o,e.tag); w16(gpsIFD,o+2,e.type); w32(gpsIFD,o+4,e.count);
    if(e.off){ w32(gpsIFD,o+8,dataOff); blobs.push(e.data); dataOff+=e.data.length; }
    else { e.val.copy(gpsIFD,o+8); }
  });
  const tiff = Buffer.concat([Buffer.alloc(8), ifd0, gpsIFD, ...blobs]);
  if(little){ tiff.write("II",0); } else { tiff.write("MM",0); }
  w16(tiff,2,0x2A); w32(tiff,4,ifd0Off);
  const app1 = Buffer.concat([Buffer.from("Exif\0\0"), tiff]);
  const seg = Buffer.alloc(4); seg.writeUInt16BE(0xFFE1,0); seg.writeUInt16BE(app1.length+2,2);
  return Buffer.concat([Buffer.from([0xFF,0xD8]), seg, app1, Buffer.from([0xFF,0xD9])]);
}

// lift exifLatLng straight out of the shipped page — testing the real code, not a copy
const html = readFileSync("public/app.html","utf8");
const src = html.slice(html.indexOf("function exifLatLng"), html.indexOf("function milesBetween"));
globalThis.FileReader = class { readAsArrayBuffer(b){ this.result = b.buffer.slice(b.byteOffset, b.byteOffset+b.byteLength); this.onload(); } };
const exifLatLng = new Function(src + "; return exifLatLng;")();

let pass=0, fail=0;
const ok=(n,c)=>{ c?(pass++,console.log("  ✓ "+n)):(fail++,console.log("  ✗ "+n)); };
const near=(a,b,t=0.0005)=>Math.abs(a-b)<t;

const emerald = [[38,1],[57,1],[204,10]], emeraldW = [[120,1],[6,1],[360,10]];
for (const little of [false,true]) {
  const buf = jpegWithGps(emerald,"N",emeraldW,"W",{little});
  const r = await exifLatLng({ slice:()=>buf });
  ok(`${little?"II (little)":"MM (big)"}-endian: lat ${r&&r.lat.toFixed(4)}`, r && near(r.lat, 38.9557));
  ok(`${little?"II":"MM"}-endian: WEST is negative — lng ${r&&r.lng.toFixed(4)}`, r && near(r.lng, -120.11));
}
const south = await exifLatLng({ slice:()=>jpegWithGps(emerald,"S",emeraldW,"E") });
ok("S hemisphere flips the sign", south && south.lat < 0 && south.lng > 0);
ok("minutes and seconds are USED, not just degrees", !near(38.9557, 38, 0.01));
ok("a non-JPEG returns null", (await exifLatLng({ slice:()=>Buffer.from([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]) })) === null);
ok("a JPEG with no EXIF returns null", (await exifLatLng({ slice:()=>Buffer.from([0xFF,0xD8,0xFF,0xD9]) })) === null);
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
