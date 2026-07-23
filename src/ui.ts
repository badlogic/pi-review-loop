import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const reviewHtmlUrl = new URL("../web/dist/index.html", import.meta.url);

export function loadReviewHtml(): string {
  return readFileSync(reviewHtmlUrl, "utf8");
}

export function reviewHtmlPath(): string {
  return fileURLToPath(reviewHtmlUrl);
}
