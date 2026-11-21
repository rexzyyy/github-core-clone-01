import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import type { GitObject } from "./store.ts";
import { hashObject } from "./store.ts";
export { hashObject };

export function pkt(data: Buffer | string): Buffer {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, "0")), b]);
}
export const flush = () => Buffer.from("0000");
export function reportPacket(line: string, sideband = true): Buffer { return pkt(sideband ? Buffer.concat([Buffer.from([1]), Buffer.from(line)]) : line); }
export function parseLsRefsRequest(packets: Buffer[]) {
  const lines=packets.map(x=>x.toString("utf8").replace(/\n$/,"")).filter(Boolean);
  return { prefixes:lines.filter(x=>x.startsWith("ref-prefix ")).map(x=>x.slice(11)), peel:lines.includes("peel"), symrefs:lines.includes("symrefs") };
}
const types: Record<number, GitObject["type"]> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
// Write valid packfiles from complete, undeltaed objects.
export function buildPack(objects: Array<{ type: GitObject["type"]; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [Buffer.from("PACK"), Buffer.from([0, 0, 0, 2]), Buffer.alloc(4)];
  chunks[2].writeUInt32BE(objects.length);
  const codes: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const o of objects) {
    let size = o.data.length, first = (codes[o.type] << 4) | (size & 15);
    size >>>= 4;
    if (size) first |= 128;
    const h: number[] = [first];
    while (size) {
      let byte = size & 127;
      size >>>= 7;
      if (size) byte |= 128;
      h.push(byte);
    }
    chunks.push(Buffer.from(h), deflateSync(o.data));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}
function readVar(b: Buffer, p: { i: number }) {
  let c = b[p.i++], size = c & 15, shift = 4, type = (c >> 4) & 7;
  while (c & 128) { c = b[p.i++]; size |= (c & 127) << shift; shift += 7; }
  return { type, size };
}
// Parse packed objects while retaining their binary payloads.
export function parsePack(b: Buffer): Array<{ type: GitObject["type"]; data: Buffer }> {
  if (b.toString("ascii", 0, 4) !== "PACK") throw Error("invalid pack");
  const count = b.readUInt32BE(8), p = { i: 12 }, out: Array<{ type: GitObject["type"]; data: Buffer }> = [];
  const offsets = new Map<number, any>(), shas = new Map<string, any>();
  for (let k = 0; k < count && p.i < b.length - 20; k++) {
    const objectOffset = p.i, hdr = readVar(b, p); let baseOffset: number | undefined, baseSha: string | undefined;
    if (hdr.type === 6) { let c = b[p.i++], ofs = c & 127; while (c & 128) { c = b[p.i++]; ofs = ((ofs + 1) << 7) | (c & 127); } baseOffset = objectOffset - ofs; }
    else if (hdr.type === 7) { baseSha = b.subarray(p.i, p.i + 20).toString("hex"); p.i += 20; }
    const start = p.i; let inflated: Buffer;
    // zlib stream ends at its own checksum; inflateSync accepts trailing bytes, info gives consumed.
    const result = inflateSync(b.subarray(start, b.length - 20), { info: true }) as any;
    inflated = result.buffer; p.i = start + result.engine.bytesWritten;
    let type = types[hdr.type], data = inflated;
    if (hdr.type === 6 || hdr.type === 7) {
      const resolved = (hdr.type === 6 ? offsets.get(baseOffset!) : shas.get(baseSha!)) as any;
      if (!resolved) throw Error("unsupported unresolved pack delta");
      data = applyDelta(resolved.data, inflated); type = resolved.type;
    }
    if (!type) throw Error("bad pack object");
    out.push({ type, data }); (out[out.length - 1] as any).sha = hashObject(type, data);
    offsets.set(objectOffset, out[out.length - 1]); shas.set((out[out.length - 1] as any).sha, out[out.length - 1]);
  }
  return out;
}
function applyDelta(base: Buffer, d: Buffer): Buffer {
  let p = 0;
  const read = () => { let n = 0, s = 0, c; do { c = d[p++]; n |= (c & 127) << s; s += 7; } while (c & 128); return n; };
  read(); const size = read(), parts: Buffer[] = [];
  while (p < d.length) {
    const op = d[p++];
    if (op & 128) { let off = 0, len = 0; for (let i = 0; i < 4; i++) if (op & (1 << i)) off |= d[p++] << (i * 8); for (let i = 0; i < 3; i++) if (op & (1 << (i + 4))) len |= d[p++] << (i * 8); if (!len) len = 0x10000; parts.push(base.subarray(off, off + len)); }
    else if (op) { parts.push(d.subarray(p, p + op)); p += op; } else throw Error("bad delta");
  }
  const result = Buffer.concat(parts); if (result.length !== size) throw Error("bad delta size"); return result;
}
export function parseTree(data: Buffer) {
  const entries: Array<{ mode: string; name: string; sha: string }> = []; let p = 0;
  while (p < data.length) { const z = data.indexOf(0, p), mode = data.toString("ascii", p, data.indexOf(32, p)), name = data.toString("utf8", data.indexOf(32, p) + 1, z); entries.push({ mode, name, sha: data.subarray(z + 1, z + 21).toString("hex") }); p = z + 21; }
  return entries;
}
export function buildTree(entries: Array<{ mode: string; name: string; sha: string }>) {
  return Buffer.concat(entries.map(e => Buffer.concat([Buffer.from(e.mode + " " + e.name + "\0"), Buffer.from(e.sha, "hex")])));
}
export function parseCommit(data: Buffer) {
  const s=data.toString(),message=s.split("\n\n").slice(1).join("\n\n").trim(),identity=(kind:string)=>{
    const m=new RegExp("^"+kind+" (.*?) <(.*?)> (\\d+) ([+-]\\d{4})$","m").exec(s);
    return m?{name:m[1],email:m[2],date:new Date(Number(m[3])*1000).toISOString()}:undefined;
  };
  return {tree:/^tree ([0-9a-f]+)/m.exec(s)?.[1]||"",parents:[...s.matchAll(/^parent ([0-9a-f]+)/gm)].map(m=>m[1]),message,author:identity("author"),committer:identity("committer")};
}
export function buildCommit(tree: string, parents: string[], message = "update") {
  return Buffer.from("tree " + tree + "\n" + parents.map(x => "parent " + x + "\n").join("") + "author Forge <forge@example.com> 0 +0000\ncommitter Forge <forge@example.com> 0 +0000\n\n" + message + "\n");
}
export function isAncestor(objects: Map<string, GitObject>, oldSha: string, newSha: string): boolean {
  if (!oldSha || /^0+$/.test(oldSha)) return true;
  const seen = new Set<string>(), stack = [newSha];
  while (stack.length) { const sha = stack.pop()!; if (sha === oldSha) return true; if (seen.has(sha)) continue; seen.add(sha); const o = objects.get(sha); if (o?.type === "commit") stack.push(...parseCommit(o.data).parents); }
  return false;
}
// Compare nested tree entries and count newline-ended blob lines.
export function diffTrees(objects: Map<string, GitObject>, before: string, after: string) {
  const walk=(sha:string,prefix="",out:Map<string,string>=new Map())=>{const o=objects.get(sha);if(o?.type!=="tree")return out;for(const e of parseTree(o.data)){const path=prefix?prefix+"/"+e.name:e.name;if(e.mode==="040000")walk(e.sha,path,out);else out.set(path,e.sha);}return out;};
  const a=walk(before),b=walk(after),paths=new Set([...a.keys(),...b.keys()]);
// Absent blobs add zero lines to the change totals.
  const lineCount=(sha?:string)=>{const o=sha&&objects.get(sha);return o?.type==="blob"?(o.data.toString().match(/\n/g)||[]).length:0;};
  return [...paths].filter(path=>a.get(path)!==b.get(path)).map(path=>{const old=a.get(path),next=b.get(path),additions=lineCount(next),deletions=lineCount(old);return {path,status:!old?"added":!next?"removed":"modified",additions,deletions,changes:additions+deletions};});
}
export function threeWayMergeValues(base: Map<string,string>, head: Map<string,string>, main: Map<string,string>) {
  const merged=new Map<string,string>(), conflicts:string[]=[];
  for(const path of new Set([...base.keys(),...head.keys(),...main.keys()])){
    const b=base.get(path),h=head.get(path),m=main.get(path);
    if(h===m){if(h!==undefined)merged.set(path,h);}
    else if(h===b){if(m!==undefined)merged.set(path,m);}
    else if(m===b){if(h!==undefined)merged.set(path,h);}
    else conflicts.push(path);
  }
  return {merged,conflicts};
}
export function treeFileMap(objects:Map<string,GitObject>,root:string,prefix="",out:Map<string,string>=new Map()) {
  const obj=objects.get(root);if(obj?.type!=="tree")return out;
  for(const e of parseTree(obj.data)){const path=prefix?prefix+"/"+e.name:e.name;if(e.mode==="040000")treeFileMap(objects,e.sha,path,out);else out.set(path,e.sha);}
  return out;
}
export function treeFromFiles(objects:Map<string,GitObject>,files:Map<string,string>) {
  type Node={files:Map<string,string>;dirs:Map<string,Node>};
  const root:Node={files:new Map(),dirs:new Map()};
  for(const [path,sha] of files){const parts=path.split("/");let node=root;for(const part of parts.slice(0,-1)){if(!node.dirs.has(part))node.dirs.set(part,{files:new Map(),dirs:new Map()});node=node.dirs.get(part)!;}node.files.set(parts.at(-1)!,sha);}
  const build=(node:Node):string=>{const entries:any[]=[];for(const [name,sha] of node.files)entries.push({mode:"100644",name,sha});for(const [name,child] of node.dirs)entries.push({mode:"040000",name,sha:build(child)});entries.sort((a,b)=>a.name.localeCompare(b.name));const data=buildTree(entries),sha=hashObject("tree",data);objects.set(sha,{type:"tree",data});return sha;};
  return build(root);
}
export function mergeTrees(objects:Map<string,GitObject>,baseTree:string,headTree:string,mainTree:string) {
  const result=threeWayMergeValues(treeFileMap(objects,baseTree),treeFileMap(objects,headTree),treeFileMap(objects,mainTree));
  if(result.conflicts.length)return {conflict:true,paths:result.conflicts};
  return {conflict:false,tree:treeFromFiles(objects,result.merged),paths:[] as string[]};
}
export function findMergeBase(objects:Map<string,GitObject>,head:string,main:string) {
  const distances=(tip:string)=>{const d=new Map<string,number>(),queue:[string,number][]=[[tip,0]];while(queue.length){const [sha,n]=queue.shift()!;if(d.has(sha))continue;d.set(sha,n);const o=objects.get(sha);if(o?.type==="commit")for(const p of parseCommit(o.data).parents)queue.push([p,n+1]);}return d;};
  const a=distances(head),b=distances(main),common=[...a.keys()].filter(x=>b.has(x)).sort((x,y)=>(a.get(x)!+b.get(x)!)-(a.get(y)!+b.get(y)!));return common[0];
}
export function reachableObjects(objects:Map<string,GitObject>,roots:string[]) {
  const found=new Map<string,GitObject>(),stack=[...roots];
  while(stack.length){const sha=stack.pop()!;if(found.has(sha))continue;const o=objects.get(sha);if(!o)continue;found.set(sha,o);
    if(o.type==="commit"){const c=parseCommit(o.data);stack.push(c.tree,...c.parents);}
    else if(o.type==="tree")for(const e of parseTree(o.data))stack.push(e.sha);
    else if(o.type==="tag"){const target=/^object ([0-9a-f]{40})/m.exec(o.data.toString())?.[1];if(target)stack.push(target);}
  }
  return found;
}
export function commitLog(objects:Map<string,GitObject>,tip:string) {
  const rows:any[]=[],seen=new Set<string>(),queue=[tip];
  while(queue.length){const sha=queue.shift()!;if(seen.has(sha))continue;seen.add(sha);const o=objects.get(sha);if(o?.type!=="commit")continue;const c=parseCommit(o.data),fallback=c.committer?.date||c.author?.date||new Date(0).toISOString(),who=(x:any)=>({name:x?.name||"forge",email:x?.email||"forge@example.com",date:x?.date||fallback});
    rows.push({sha,commit:{message:c.message||"Commit",author:who(c.author),committer:who(c.committer)},parents:c.parents.map(parent=>({sha:parent}))});queue.push(...c.parents);
  }
  return rows;
}
