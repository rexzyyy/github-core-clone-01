import { createHash } from "node:crypto";

export type GitObject = { type: "blob" | "tree" | "commit" | "tag"; data: Buffer };
export type Repo = {
  id: string; name: string; nameWithOwner: string; owner: { login: string };
  boundOwner: string | null; description: string; defaultBranch: string; private: boolean; createdAt: string; updatedAt: string;
  refs: Map<string, string>; objects: Map<string, GitObject>;
  issues: Map<number, any>; pullRequests: Map<number, any>; labels: Map<string, any>;
  contents: Map<string, string>; nextIssueNumber: number;
};
export const repositories = new Map<string, Repo>();
let sequence = 0;
export function id(): string { sequence++; return String(sequence); }
export function timestamp(): string {
  return process.env.MAKEFUN_TRIAL_NOW || new Date(Date.UTC(2020, 0, 1) + sequence * 1000).toISOString();
}
export function repoKey(owner: string, name: string) { return owner + "/" + name; }
export function resolveRepo(owner: string, name: string) {
  const r = repositories.get(name);
  if (!r) return undefined;
  if (r.boundOwner === null) { r.boundOwner = owner; r.owner.login = owner; r.nameWithOwner = owner + "/" + name; }
  return r.boundOwner === owner ? r : undefined;
}
export function getRepo(owner: string, name: string) { return resolveRepo(owner, name); }
export function createRepo(owner: string | null, name: string, description = "", isPrivate = false): Repo {
  const now = timestamp(), r: Repo = {
    id: id(), name, nameWithOwner: owner ? owner + "/" + name : "/" + name, owner: { login: owner || "" }, boundOwner: owner,
    description, defaultBranch: "main", private: isPrivate, createdAt: now, updatedAt: now,
    refs: new Map(), objects: new Map(), issues: new Map(), pullRequests: new Map(),
    labels: new Map(), contents: new Map(), nextIssueNumber: 1
  };
  repositories.set(name, r); return r;
}
export function hashObject(type: string, data: Buffer): string {
  return createHash("sha1").update(type + " " + data.length + "\0").update(data).digest("hex");
}
export function putObject(r: Repo, type: GitObject["type"], data: Buffer): string {
  const sha = hashObject(type, data); r.objects.set(sha, { type, data }); return sha;
}
