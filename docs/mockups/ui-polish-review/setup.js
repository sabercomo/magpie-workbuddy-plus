// This entire preview is local and uses generated fixture data.
const previewQuery = new URLSearchParams(location.search);
globalThis.UI_REVIEW = previewQuery.get("compare") !== "before";
localStorage.setItem("wb-tab", previewQuery.get("tab") || "tasks");
localStorage.setItem("wb-nav", "top");
localStorage.setItem("wb-view", "list");
document.documentElement.dataset.theme = previewQuery.has("dark") ? "dark" : "light";
