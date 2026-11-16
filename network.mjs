// A connection dropped or timed out on the way (a proxy resetting it, a
// temporary DNS failure, a refused connection). Upstream refusals carry a
// status; those are not network failures.
export const dropped = e => !e?.status && !e?.limited && /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_CONNECT_TIMEOUT|TimeoutError|socket|fetch failed|network|timed out|timeout/i.test(`${e?.code || ""} ${e?.name || ""} ${e?.message || ""} ${e?.cause?.code || ""}`);
