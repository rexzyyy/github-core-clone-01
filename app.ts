import { createServer, type Server } from "node:http";
import { createRepo, getRepo, repositories, id, timestamp, putObject } from "./store.ts";
import { buildPack, pkt, flush, buildTree, parseTree, buildCommit, parseCommit, isAncestor, diffTrees, reportPacket, parseLsRefsRequest, mergeTrees, findMergeBase, commitLog } from "./git.ts";
import { executeGraphQL } from "./graphql.ts";

let requestId = 0;
export function classifyIssueRoute(tail:string) {
  const comments=/^issues\/(\d+)\/comments\/?$/.exec(tail);
  if(comments)return {kind:"comments",number:Number(comments[1])};
  const issue=/^issues\/(\d+)\/?$/.exec(tail);
  return issue?{kind:"issue",number:Number(issue[1])}:null;
}
function json(res: any, status: number, value?: any, headers: any = {}) {
  res.writeHead(status, { "content-type": "application/json", "X-GitHub-Request-Id": "forge" + (++requestId), ...headers });
  res.end(value === undefined ? "" : JSON.stringify(value));
}
// Keep request bytes intact for binary Git pack processing.
async function body(req: any): Promise<Buffer> { const a: Buffer[] = []; for await (const c of req) a.push(c); return Buffer.concat(a); }
function auth(req: any) {
  const token = process.env.MAKEFUN_SHOP_TOKEN || "";
  return !!token && req.headers.authorization === "Bearer " + token;
}
// Use the bound viewer identity when the token has established one.
function ownerLogin() { return [...repositories.values()].find(r => r.boundOwner)?.boundOwner || "viewer"; }
function getCommit(r: any) { const sha = r.refs.get("refs/heads/" + r.defaultBranch); return sha ? r.objects.get(sha) : undefined; }
// Convert storage-only repository state to the public REST representation.
function repoJSON(r: any) { const fullName=r.boundOwner?r.boundOwner+"/"+r.name:r.name; return { id: Number(r.id), name: r.name, full_name: fullName, owner: { login: r.owner.login }, description: r.description, default_branch: r.defaultBranch, private: r.private, created_at: r.createdAt, updated_at: r.updatedAt, html_url: "https://example.com/" + fullName, clone_url: "" }; }
function paged(url: URL, values: any[]) {
  const per = Math.max(1, Number(url.searchParams.get("per_page") || 30)), page = Math.max(1, Number(url.searchParams.get("page") || 1)), start = (page - 1) * per;
  const headers: any = {};
  if (start + per < values.length) { const next = new URL(url); next.searchParams.set("page", String(page + 1)); next.searchParams.set("per_page", String(per)); headers.Link = '<' + next.pathname + next.search + '>; rel="next"'; }
  return { values: values.slice(start, start + per), headers };
}
// Decode Git request lines, including delimiter and flush packet markers.
function pktLines(b: Buffer) {
  const lines: Buffer[] = []; let i = 0;
  while (i + 4 <= b.length) { const n = parseInt(b.toString("ascii", i, i + 4), 16); i += 4; if (!n) continue; if(n===1){lines.push(Buffer.alloc(0));continue;} if (!Number.isFinite(n) || n < 4 || i + n - 4 > b.length) break; lines.push(b.subarray(i, i + n - 4)); i += n - 4; }
  return lines;
}
// Split pack data into bounded side-band payload packets.
function sideband(pack: Buffer) {
  const packets: Buffer[] = [];
  for (let i = 0; i < pack.length; i += 65515) packets.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(i, i + 65515)])));
  return Buffer.concat(packets);
}
function treeEntries(r: any, sha?: string) { const o = sha && r.objects.get(sha); return o?.type === "tree" ? parseTree(o.data) : []; }
function editTree(r: any, root: string | undefined, parts: string[], blob: string | null): string {
  const entries = treeEntries(r, root), name = parts[0], at = entries.findIndex((e: any) => e.name === name);
  if (parts.length === 1) {
    if (blob) { if (at >= 0) entries[at] = { mode: "100644", name, sha: blob }; else entries.push({ mode: "100644", name, sha: blob }); }
    else if (at >= 0) entries.splice(at, 1);
  } else {
    const child = at >= 0 ? entries[at].sha : undefined, next = editTree(r, child, parts.slice(1), blob);
    if (treeEntries(r, next).length) { const item = { mode: "040000", name, sha: next }; if (at >= 0) entries[at] = item; else entries.push(item); }
    else if (at >= 0) entries.splice(at, 1);
  }
  entries.sort((a: any, b: any) => a.name.localeCompare(b.name));
  return putObject(r, "tree", buildTree(entries));
}
function findPath(r: any, root: string | undefined, parts: string[]): any {
  let sha = root, entry: any;
  for (let i = 0; i < parts.length; i++) { entry = treeEntries(r, sha).find((e: any) => e.name === parts[i]); if (!entry) return undefined; sha = entry.sha; }
  return entry;
}
function fileResult(r: any, path: string, entry: any, includeContent: boolean) {
  const obj = r.objects.get(entry.sha), out: any = { name: entry.name, path, sha: entry.sha, size: obj?.data.length || 0, type: "file", encoding: "base64" };
  if (includeContent) out.content = obj?.data.toString("base64") || "";
  return out;
}
// Convert a commit pair into the REST and GraphQL file-change shape.
function fileDiff(r:any, baseSha:string, headSha:string) {
  const commitTree=(sha:string)=>{const o=r.objects.get(sha);return o?.type==="commit"?parseCommit(o.data).tree:"";};
  return diffTrees(r.objects,commitTree(baseSha),commitTree(headSha)).map(x=>({...x,filename:x.path}));
}
export function fetchPlan(r:any,request:string) {
  const wants=[...request.matchAll(/want ([0-9a-f]{40})/g)].map(m=>m[1]), haves=[...request.matchAll(/have ([0-9a-f]{40})/g)].map(m=>m[1]), deepen=Number(/deepen (\d+)/.exec(request)?.[1]||0), deepenSince=Number(/deepen-since (\d+)/.exec(request)?.[1]||0);
  const extra=[...request.matchAll(/deepen-not ([^\n\0]+)/g)].map(m=>r.refs.get(m[1].trim())).filter(Boolean);
  const clientShallow=[...request.matchAll(/shallow ([0-9a-f]{40})/g)].map(m=>m[1]);
  const walk=(roots:string[],limit=0,since=0,stopParents:Set<string>=new Set())=>{const found=new Map<string,any>(),boundaries=new Set<string>(),seen=new Set<string>(),stack=roots.map(sha=>({sha,depth:1}));while(stack.length){const {sha,depth}=stack.pop()!,key=sha+":"+depth;if(seen.has(key))continue;seen.add(key);const o=r.objects.get(sha);if(!o)continue;found.set(sha,o);
      if(o.type==="commit"){const c=parseCommit(o.data),date=Number(/^committer .* (\d+) [+-]\d{4}$/m.exec(o.data.toString())?.[1]||0),dateBoundary=since>0&&date<since;stack.push({sha:c.tree,depth});if(stopParents.has(sha))continue;if((limit&&depth>=limit)||dateBoundary){boundaries.add(sha);continue;}for(const parent of c.parents)stack.push({sha:parent,depth:depth+1});}
      else if(o.type==="tree")for(const e of parseTree(o.data))stack.push({sha:e.sha,depth});
      else if(o.type==="tag"){const target=/^object ([0-9a-f]{40})/m.exec(o.data.toString())?.[1];if(target)stack.push({sha:target,depth});}
    }return {found,boundaries};};
  const held=walk([...haves,...extra,...clientShallow],0,0,new Set(clientShallow)).found, fetched=walk(wants, deepen,deepenSince);
  return {haves:haves.filter(sha=>r.objects.has(sha)), objects:[...fetched.found].filter(([sha])=>!held.has(sha)).map(([,obj])=>obj), shallow:[...fetched.boundaries], deepen,since:deepenSince};
}
export function mergePull(r:any,pr:any) {
  if(pr.merged)return {status:405,body:{message:"Pull request is already merged"}};
  const headTip=r.refs.get("refs/heads/"+pr.head.ref)||pr.head.sha,baseTip=r.refs.get("refs/heads/"+pr.base.ref)||pr.base.sha,headCommit=r.objects.get(headTip),baseCommit=r.objects.get(baseTip);
  if(headCommit?.type!=="commit"||baseCommit?.type!=="commit")return {status:405,body:{message:"Pull request cannot be merged"}};
  const baseSha=findMergeBase(r.objects,headTip,baseTip);if(!baseSha)return {status:405,body:{message:"Pull request has no common ancestor"}};
  const ancestor=r.objects.get(baseSha);if(ancestor?.type!=="commit")return {status:405,body:{message:"Pull request has no common ancestor"}};
  const result=mergeTrees(r.objects,parseCommit(ancestor.data).tree,parseCommit(headCommit.data).tree,parseCommit(baseCommit.data).tree);
  if(result.conflict)return {status:405,body:{message:"Merge conflict"}};
  const sha=putObject(r,"commit",buildCommit(result.tree,[baseTip],pr.title));r.refs.set("refs/heads/"+r.defaultBranch,sha);pr.state="closed";pr.merged=true;pr.mergeSha=sha;pr.merged_at=timestamp();
  return {status:200,body:{sha,merged:true,message:"Pull Request successfully merged"}};
}
export function createApp(): Server {
return createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://local"), p = decodeURI(url.pathname), method = req.method || "GET";
    if (p === "/healthz") return json(res, 200, { ok: true });
    if (p.endsWith(".git/info/refs")) {
      const m = /^\/([^/]+)\/([^/]+)\.git\/info\/refs$/.exec(p), r = m && getRepo(m[1], m[2]);
      if (!r) return json(res, 404, { message: "Not Found" });
      const service = url.searchParams.get("service") || "git-upload-pack", branchRefs=[...r.refs], refs: Array<[string,string]> = branchRefs.length ? [["HEAD",r.refs.get("refs/heads/"+r.defaultBranch)||"0000000000000000000000000000000000000000"], ...branchRefs] : [];
      let out: Buffer;
      if (service === "git-upload-pack" && req.headers["git-protocol"] === "version=2") out = Buffer.concat([pkt("version 2\n"), pkt("ls-refs\n"), pkt("fetch=shallow wait-for-done\n"), pkt("object-format=sha1\n"), pkt("agent=forge/1.0\n"), flush()]);
      else {
        const caps = (service === "git-receive-pack" ? "report-status side-band-64k delete-refs ofs-delta agent=forge/1.0" : "side-band-64k multi_ack thin-pack ofs-delta agent=forge/1.0") + " symref=HEAD:refs/heads/" + r.defaultBranch;
        const rows = refs.length
          ? refs.map(([ref, sha], i) => pkt(sha + " " + ref + (i ? "\n" : "\0" + caps + "\n")))
          : [pkt("0000000000000000000000000000000000000000 capabilities^{}\0" + caps + "\n")];
        out = Buffer.concat([pkt("# service=" + service + "\n"), flush(), ...rows, flush()]);
      }
      res.writeHead(200, { "content-type": "application/x-" + service + "-advertisement", "X-GitHub-Request-Id":"forge"+(++requestId) }); return res.end(out);
    }
    const gitm = /^\/([^/]+)\/([^/]+)\.git\/(git-upload-pack|git-receive-pack)$/.exec(p);
    if (gitm && method === "POST") {
      const r = getRepo(gitm[1], gitm[2]); if (!r) return json(res, 404, { message: "Not Found" });
      const data = await body(req);
      if (gitm[3] === "git-upload-pack") {
        const text = pktLines(data).map(x => x.toString()).join("");
        if (text.includes("command=ls-refs")) {
          const packets=pktLines(data), request=parseLsRefsRequest(packets), defaultRef="refs/heads/"+r.defaultBranch, headSha=r.refs.get(defaultRef);
          const matches=(ref:string)=>!request.prefixes.length||request.prefixes.some(prefix=>ref.startsWith(prefix));
          const lines:Buffer[]=[];
          if(!request.prefixes.length||request.prefixes.some(prefix=>"HEAD".startsWith(prefix)))lines.push(pkt(headSha ? headSha+" HEAD"+(request.symrefs?" symref-target:"+defaultRef:"")+"\n" : "unborn HEAD"+(request.symrefs?" symref-target:"+defaultRef:"")+"\n"));
          for(const [ref,sha] of r.refs){if(!matches(ref))continue;let attrs=request.symrefs&&ref===defaultRef?" symref-target:"+defaultRef:"";if(request.peel&&r.objects.get(sha)?.type==="tag"){const tag=r.objects.get(sha)!,target=/^object ([0-9a-f]{40})/m.exec(tag.data.toString())?.[1];if(target)attrs+=" peeled:"+target;}lines.push(pkt(sha+" "+ref+attrs+"\n"));}
          return res.writeHead(200, { "content-type": "application/x-git-upload-pack-result", "X-GitHub-Request-Id":"forge"+(++requestId) }), res.end(Buffer.concat([...lines, flush()]));
        }
        const plan=fetchPlan(r,text), pack=buildPack(plan.objects.map((o:any)=>({type:o.type,data:o.data})));
        if (text.includes("command=fetch")) {
          const ack=[pkt("acknowledgments\n"),...(plan.haves.length?plan.haves.map((sha:string)=>pkt("ACK "+sha+"\n")):[pkt("NAK\n")]),flush()];
          const shallow=plan.deepen||plan.since?[pkt("shallow-info\n"),...plan.shallow.map((sha:string)=>pkt("shallow "+sha+"\n")),flush()]:[];
          return res.writeHead(200, { "content-type": "application/x-git-upload-pack-result", "X-GitHub-Request-Id":"forge"+(++requestId) }), res.end(Buffer.concat([...ack,...shallow,pkt("packfile\n"),sideband(pack),flush()]));
        }
        const ack=plan.haves.length?plan.haves.map((sha:string)=>pkt("ACK "+sha+"\n")):[pkt("NAK\n")];
        const shallow=plan.deepen||plan.since?plan.shallow.map((sha:string)=>pkt("shallow "+sha+"\n")):[];
        return res.writeHead(200, { "content-type": "application/x-git-upload-pack-result", "X-GitHub-Request-Id":"forge"+(++requestId) }), res.end(Buffer.concat([...ack,...shallow,sideband(pack),flush()]));
      }
      const idx = data.indexOf(Buffer.from("PACK")); let updates: Array<{ old: string; next: string; ref: string }> = [];
      const updatePackets=pktLines(data.subarray(0, idx < 0 ? data.length : idx)), capabilities=updatePackets[0]?.toString().split("\0")[1]||"", sidebandReports=capabilities.split(" ").includes("side-band-64k");
      let lines = updatePackets.map(x => x.toString().replace(/\n$/, "").split("\0")[0]);
      for (const line of lines) { const a = line.split(" "); if (a.length >= 3) updates.push({ old: a[0], next: a[1], ref: a[2] }); }
      if (idx >= 0) for (const o of (await import("./git.ts")).parsePack(data.subarray(idx))) putObject(r, o.type, o.data);
      let response = reportPacket("unpack ok\n",sidebandReports);
      for (const u of updates) {
        if (/^0+$/.test(u.next)) { r.refs.delete(u.ref); response = Buffer.concat([response, reportPacket("ok " + u.ref + "\n",sidebandReports)]); }
        else if (!isAncestor(r.objects, u.old, u.next)) response = Buffer.concat([response, reportPacket("ng " + u.ref + " non-fast-forward\n",sidebandReports)]);
        else { r.refs.set(u.ref, u.next); response = Buffer.concat([response, reportPacket("ok " + u.ref + "\n",sidebandReports)]); }
      }
      return res.writeHead(200, { "content-type": "application/x-git-receive-pack-result", "X-GitHub-Request-Id":"forge"+(++requestId) }), res.end(Buffer.concat([response, flush()]));
    }
    if (p === "/api/v3/" && method === "GET") return auth(req) ? json(res, 200, {}, { "X-OAuth-Scopes": "repo, read:org", "X-Oauth-Scopes": "repo, read:org" }) : json(res, 401, { message: "Bad credentials" });
    if (p === "/api/v3/meta" && method === "GET") return auth(req) ? json(res, 200, { installed_version: "1.0.0" }) : json(res, 401, { message: "Bad credentials" });
    if (p.startsWith("/api/v3/")) {
      if (!auth(req)) return json(res, 401, { message: "Bad credentials" });
      let b: any = {}; if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") { const raw = (await body(req)).toString(); if (raw) try { b = JSON.parse(raw); } catch { return json(res, 400, { message: "Malformed JSON" }); } }
      if (p === "/api/v3/user/repos" && method === "POST") {
        if (!b.name || repositories.has(b.name)) return json(res, 422, { message: "Repository already exists" });
        return json(res, 201, repoJSON(createRepo(null, b.name, b.description || "", b.private === true)));
      }
      if (p === "/api/v3/user/repos" && method === "GET") { const pg = paged(url, [...repositories.values()].map(repoJSON)); return json(res, 200, pg.values, pg.headers); }
      const m = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(p);
      if (m) {
        const [, owner, name, tail = ""] = m;
        const r = getRepo(owner, name);
      if (!r && !tail && method === "GET") return json(res, 404, { message: "Not Found" }); // Unknown repositories use the standard JSON error.
        if (!r && !tail && method === "DELETE") return json(res, 404, { message: "Not Found" });
        if (!r) return json(res, 404, { message: "Not Found" });
        if (!tail && method === "GET") return json(res, 200, repoJSON(r));
        if (!tail && method === "PATCH") { r.description = b.description || ""; return json(res, 200, repoJSON(r)); }
        if (!tail && method === "DELETE") { repositories.delete(name); return json(res, 204); }
        if (tail === "git/refs" && method === "POST") {
          const obj=r.objects.get(b.sha);
          if(!b.ref || obj?.type!=="commit") return json(res,422,{message:"Invalid reference or object"});
          r.refs.set(b.ref,b.sha); return json(res,201,{ref:b.ref,object:{sha:b.sha}});
        }
        if (tail === "branches" && method === "GET") return json(res,200,[...r.refs].filter(([ref])=>ref.startsWith("refs/heads/")).map(([ref,sha])=>({name:ref.slice(11),commit:{sha}})));
        if (tail === "commits" && method === "GET") {
          const requested=String(url.searchParams.get("sha")||r.defaultBranch); let sha=r.refs.get(requested)||r.refs.get("refs/heads/"+requested)||requested;
          return json(res,200,commitLog(r.objects,sha));
        }
        if (tail === "labels" && method === "GET") return json(res, 200, [...r.labels.values()]);
        if (tail === "labels" && method === "POST") { const l = { name: b.name, color: b.color || "ededed", description: b.description || "" }; r.labels.set(l.name, l); return json(res, 201, l); }
        if (tail === "issues" && method === "GET") { let issues=[...r.issues.values()].filter(i => !url.searchParams.get("state") || url.searchParams.get("state") === "all" || i.state === url.searchParams.get("state")); if(url.searchParams.get("sort")==="created"){const dir=url.searchParams.get("direction")==="asc"?1:-1;issues.sort((a,b)=>dir*(a.created_at.localeCompare(b.created_at)||a.number-b.number));} const pg=paged(url,issues); return json(res,200,pg.values,pg.headers); }
        if (tail === "issues" && method === "POST") { const names = b.labels || []; if (names.some((l: any) => !r.labels.has(typeof l==="string"?l:l.name))) return json(res, 422, { message: "Validation failed" }); const labels=names.map((l:any)=>r.labels.get(typeof l==="string"?l:l.name)); const n = r.nextIssueNumber++, issue = { id: id(), number: n, title: b.title, body: b.body || "", state: "open", labels, comments:[], created_at: timestamp(), updated_at: timestamp(), user: { login: owner } }; r.issues.set(n, issue); return json(res, 201, issue); }
        const issueRoute=classifyIssueRoute(tail); if(issueRoute?.kind==="comments"){const issue=r.issues.get(issueRoute.number);if(!issue)return json(res,404,{message:"Not Found"});issue.comments??=[];if(method==="GET")return json(res,200,issue.comments);if(method==="POST"){const now=timestamp(),comment={id:id(),body:b.body||"",user:{login:owner},created_at:now,updated_at:now};issue.comments.push(comment);return json(res,201,comment);}}
        const singleIssue=classifyIssueRoute(tail); if(singleIssue?.kind==="issue"){const x=r.issues.get(singleIssue.number);if(!x)return json(res,404,{message:"Not Found"});if(method==="PATCH")Object.assign(x,{title:b.title??x.title,body:b.body??x.body,state:b.state??x.state,updated_at:timestamp()});return json(res,200,x);}
        if (tail === "pulls" && method === "POST") { const headRef=String(b.head||"").replace(/^refs\/heads\//,""),baseRef=String(b.base||"").replace(/^refs\/heads\//,""),sha = r.refs.get("refs/heads/" + headRef); if (!sha) return json(res, 422, { message: "Head branch not found" }); const n = r.nextIssueNumber++, pr = { id: id(), number: n, title: b.title, body: b.body || "", state: "open", head: { ref: headRef, sha }, base: { ref: baseRef, sha: r.refs.get("refs/heads/" + baseRef) || "" }, headRefName: headRef, baseRefName: baseRef, mergeable: true, merged: false, createdAt: timestamp(), updatedAt: timestamp() }; r.pullRequests.set(n, pr); return json(res, 201, pr); }
        if (tail === "pulls" && method === "GET") { const state=url.searchParams.get("state")||"open",prs=[...r.pullRequests.values()].filter(x=>state==="all"||x.state===state); const pg=paged(url,prs); return json(res,200,pg.values,pg.headers); }
        const pf=/^pulls\/(\d+)\/files$/.exec(tail); if(pf&&method==="GET"){const pr=r.pullRequests.get(+pf[1]);if(!pr)return json(res,404,{message:"Not Found"});const base=r.refs.get("refs/heads/"+pr.base.ref)||pr.base.sha,head=r.refs.get("refs/heads/"+pr.head.ref)||pr.head.sha;return json(res,200,fileDiff(r,base,head).map(f=>({filename:f.filename,status:f.status,additions:f.additions,deletions:f.deletions,changes:f.changes})));}
        const pm = /^pulls\/(\d+)(?:\/(merge))?$/.exec(tail); if (pm) { const pr = r.pullRequests.get(+pm[1]); if (!pr) return json(res, 404, { message: "Not Found" }); if (pm[2] && method === "PUT") { const merged=mergePull(r,pr); return json(res,merged.status,merged.body); } return json(res, 200, pr); }
        if (tail.startsWith("contents/")) {
          const path = tail.slice(9), parts = path.split("/").filter(Boolean), requestedRef=String(url.searchParams.get("ref")||r.defaultBranch).replace(/^refs\/heads\//,""), head = r.refs.get("refs/heads/" + requestedRef), commit = head && r.objects.get(head), root = commit?.type === "commit" ? parseCommit(commit.data).tree : undefined, entry = findPath(r, root, parts);
          if (method === "GET") {
            if (entry) { if (entry.mode === "040000") { const arr = treeEntries(r, entry.sha).map((e: any) => ({ name:e.name, path:path + "/" + e.name, sha:e.sha, type:e.mode === "040000" ? "dir" : "file" })); return json(res, 200, arr); } return json(res, 200, fileResult(r, path, entry, true)); }
            const parent = findPath(r, root, parts.slice(0, -1));
            if (parent?.mode === "040000") return json(res, 200, treeEntries(r, parent.sha).map((e: any) => ({ name:e.name, path:(path ? path + "/" : "") + e.name, sha:e.sha, type:e.mode === "040000" ? "dir" : "file" })));
            return json(res, 404, { message: "Not Found" });
          }
          if (method === "PUT") {
            const branch=String(b.branch||r.defaultBranch).replace(/^refs\/heads\//,""),branchHead=r.refs.get("refs/heads/"+branch),branchCommit=branchHead&&r.objects.get(branchHead),branchRoot=branchCommit?.type==="commit"?parseCommit(branchCommit.data).tree:undefined,branchEntry=findPath(r,branchRoot,parts);
            if (b.sha && b.sha !== branchEntry?.sha) return json(res, 409, { message: "sha does not match" });
            const existed = !!branchEntry, blob = putObject(r, "blob", Buffer.from(b.content || "", "base64")), tree = editTree(r, branchRoot, parts, blob), next = putObject(r, "commit", buildCommit(tree, branchHead ? [branchHead] : [], b.message || ""));
            r.refs.set("refs/heads/" + branch, next); if(branch===r.defaultBranch)r.contents.set(path, blob);
            return json(res, existed ? 200 : 201, { content: { name: parts.at(-1), path, sha: blob, size: Buffer.from(b.content || "", "base64").length, type:"file", encoding:"base64" }, commit:{ sha:next, message:b.message || "" } });
          }
          if (method === "DELETE") {
            const branch=String(b.branch||requestedRef).replace(/^refs\/heads\//,""),branchHead=r.refs.get("refs/heads/"+branch),branchCommit=branchHead&&r.objects.get(branchHead),branchRoot=branchCommit?.type==="commit"?parseCommit(branchCommit.data).tree:undefined,branchEntry=findPath(r,branchRoot,parts);
            if (!branchEntry || b.sha !== branchEntry.sha) return json(res, 409, { message: "sha does not match" });
            const tree = editTree(r, branchRoot, parts, null), next = putObject(r, "commit", buildCommit(tree, branchHead ? [branchHead] : [], b.message || ""));
            r.refs.set("refs/heads/" + branch, next); if(branch===r.defaultBranch)r.contents.delete(path); return json(res, 200, { commit:{ sha:next } });
          }
        }
      }
      return json(res, 404, { message: "Not Found" });
    }
    if (p === "/api/graphql" && method === "POST") { if (!auth(req)) return json(res, 401, { message: "Bad credentials" }); let q:any; try { q=JSON.parse((await body(req)).toString()); } catch { return json(res,400,{message:"Malformed JSON"}); } const result=executeGraphQL(q.query||"",q.variables||{}); return json(res,200,result); }
    if (p === "/mcp" && method === "POST") {
      if (!auth(req)) return json(res, 401, { message: "Unauthorized" });
      let q: any; try { q = JSON.parse((await body(req)).toString()); } catch { return json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }); }
      if (!("id" in q)) return res.writeHead(202, { "X-GitHub-Request-Id":"forge"+(++requestId) }).end();
      if (q.method === "server/discover") return json(res, 200, { jsonrpc: "2.0", id: q.id, result: { supportedVersions: ["2026-07-28", "2025-11-25"] } });
      if (q.method === "initialize") return json(res, 200, { jsonrpc: "2.0", id: q.id, result: { protocolVersion: q.params?.protocolVersion || "2025-11-25", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "forge", version: "1.0.0" } } });
      if (q.method === "tools/list") { const schemas:any = {
        create_repo:{name:"string"},get_repo:{owner:"string",repo:"string"},create_issue:{owner:"string",repo:"string",title:"string",body:"string",labels:"array"},list_issues:{owner:"string",repo:"string",state:"string"},create_pull_request:{owner:"string",repo:"string",title:"string",head:"string",base:"string"},merge_pull_request:{owner:"string",repo:"string",pull_number:"number"}
      }; const tools=Object.entries(schemas).map(([name,props]:any)=>({name,description:"Git forge operation: "+name,inputSchema:{type:"object",properties:Object.fromEntries(Object.entries(props).map(([k,v])=>[k,{type:v}]))}})); return json(res, 200, { jsonrpc: "2.0", id: q.id, result: { tools } }); }
      if (q.method === "tools/call") {
        const args=q.params?.arguments||{}, suffix=String(q.params?.name||"").toLowerCase().split(/[^a-z0-9_]+/).at(-1), name=["create_repo","get_repo","create_issue","list_issues","create_pull_request","merge_pull_request"].find(x=>suffix?.endsWith(x));
        if(!name) return json(res,200,{jsonrpc:"2.0",id:q.id,error:{code:-32602,message:"Unknown tool"}});
        const required:any={create_repo:["name"],get_repo:["owner","repo"],create_issue:["owner","repo","title"],list_issues:["owner","repo"],create_pull_request:["owner","repo","title","head","base"],merge_pull_request:["owner","repo","pull_number"]};
        const missing=required[name].filter((key:string)=>args[key]===undefined||args[key]===null||args[key]==="");
        if(missing.length)return json(res,200,{jsonrpc:"2.0",id:q.id,result:{isError:true,content:[{type:"text",text:"Missing required argument: "+missing[0]}]}});
        let result:any, r=getRepo(args.owner||ownerLogin(),args.repo||args.name||"");
        if(name==="create_repo") { if(!args.name)return json(res,200,{jsonrpc:"2.0",id:q.id,result:{isError:true,content:[{type:"text",text:"missing name"}]}}); r=getRepo(ownerLogin(),args.name)||createRepo(null,args.name);result=repoJSON(r); }
        else if(name==="get_repo") result=r?repoJSON(r):{message:"Not Found"};
        else if(!r) result={message:"Not Found"};
        else if(name==="create_issue") { const names=args.labels||[]; if(names.some((x:any)=>!r!.labels.has(typeof x==="string"?x:x.name)))result={message:"Validation failed"};else{const labels=names.map((x:any)=>r!.labels.get(typeof x==="string"?x:x.name)),n=r.nextIssueNumber++,x={id:id(),number:n,title:args.title,body:args.body||"",state:"open",labels,comments:[],created_at:timestamp(),updated_at:timestamp(),user:{login:r.owner.login}};r.issues.set(n,x);result=x;} }
        else if(name==="list_issues") result=[...r.issues.values()].filter(x=>(args.state||"open")==="all"||x.state===(args.state||"open"));
        else if(name==="create_pull_request") { const head=String(args.head).replace(/^refs\/heads\//,""),base=String(args.base).replace(/^refs\/heads\//,""),sha=r.refs.get("refs/heads/"+head);if(!sha)result={message:"Head branch not found"};else{const n=r.nextIssueNumber++,x={id:id(),number:n,title:args.title,body:args.body||"",state:"open",head:{ref:head,sha},base:{ref:base,sha:r.refs.get("refs/heads/"+base)||""},headRefName:head,baseRefName:base,mergeable:true,merged:false,createdAt:timestamp(),updatedAt:timestamp()};r.pullRequests.set(n,x);result=x;} }
        else { const pr=r.pullRequests.get(Number(args.pull_number));if(!pr)result={message:"Not Found"};else{const merged=mergePull(r,pr);result=merged.body;} }
        return json(res,200,{jsonrpc:"2.0",id:q.id,result:{content:[{type:"text",text:JSON.stringify(result)}]}});
      }
      return json(res, 200, { jsonrpc: "2.0", id: q.id, error: { code: -32601, message: "Method not found" } });
    }
    return json(res, 404, { message: "Not Found" });
  } catch (e: any) { json(res, 500, { message: e?.message || "Internal Server Error" }); }
});
}
