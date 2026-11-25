const API = "https://api.github.com";

function encodePath(path) {
  return String(path).split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

// GitHubConflict is a conditional write that lost its race: the file has a
// different sha now. The caller re-reads and decides with the new state.
export class GitHubConflict extends Error {
  constructor(message) {
    super(message);
    this.name = "GitHubConflict";
    this.conflict = true;
  }
}

// GitHubContents is a tiny Contents API client for one repository, using
// the same token and branch Magpie already uses in sync.json. It only talks
// to api.github.com: no redirect or download URL is followed.
export class GitHubContents {
  constructor({ repo, token, branch = "", fetcher = fetch, signal }) {
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(String(repo || ""))) {
      throw new Error("GitHub repository must be owner/repo");
    }
    if (!token) throw new Error("GitHub token is empty");
    this.repo = repo;
    this.token = token;
    this.branch = branch;
    this.fetcher = fetcher;
    this.signal = signal;
  }

  async request(method, apiPath, body, attempt = 0) {
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "magpie-workbuddy-sync",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await this.fetcher(`${API}/repos/${this.repo}${apiPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      });
    } catch (e) {
      if (method === "GET" && attempt < 2 && !this.signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        return this.request(method, apiPath, body, attempt + 1);
      }
      throw e;
    }
    // GETs are safe to retry on a temporary gateway/rate-limit failure.
    if (method === "GET" && [502, 503, 504].includes(response.status) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      return this.request(method, apiPath, body, attempt + 1);
    }
    return response;
  }

  async checkPrivate() {
    const response = await this.request("GET", "");
    if (!response.ok) throw new Error(`GitHub repository check failed: HTTP ${response.status}`);
    if ((await response.json())?.private !== true) throw new Error("GitHub repository is not private");
    return true;
  }

  async read(file) {
    const query = this.branch ? `?ref=${encodeURIComponent(this.branch)}` : "";
    const response = await this.request("GET", `/contents/${encodePath(file)}${query}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub read failed: HTTP ${response.status}`);
    const value = await response.json();
    if (Array.isArray(value) || !value || typeof value !== "object") {
      throw new Error(`GitHub path ${file} is not a file`);
    }
    if (value.type !== "file" || value.encoding !== "base64" || typeof value.content !== "string" || !/^[a-f0-9]{40}$/.test(value.sha)) {
      throw new Error("Invalid GitHub file response");
    }
    return {
      data: Buffer.from(value.content.replace(/\s/g, ""), "base64"),
      sha: String(value.sha || ""),
      size: Number(value.size || 0),
    };
  }

  // writeIf writes only if the file is still at expectedSha: null for a file
  // that did not exist. A 409/422 is a lost race, not a transport failure.
  async writeIf(file, bytes, message = "workbuddy-sync: publish", expectedSha = null) {
    const body = {
      message,
      content: Buffer.from(bytes).toString("base64"),
    };
    if (expectedSha) body.sha = expectedSha;
    if (this.branch) body.branch = this.branch;
    const response = await this.request("PUT", `/contents/${encodePath(file)}`, body);
    if (response.ok) {
      const value = await response.json();
      return { sha: String(value?.content?.sha || "") };
    }
    const error = new Error(`GitHub write failed: HTTP ${response.status}`);
    if (response.status === 409 || response.status === 422 || response.status === 404) {
      throw new GitHubConflict(error.message);
    }
    throw error;
  }

}
